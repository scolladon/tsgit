# Plan — pack-registry single-flight (no orphaned FileHandles)

> Source: design doc `docs/design/pack-registry-single-flight.md` · ADRs 566, 567, 568, 569, 570, 571
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.

4 parts, sequential, one shared working tree. Each part is an atomic conventional commit.

### How to read this plan

Every part block below is self-contained: paths, current signatures, the exact code
shape to land, the fixtures to reuse, the RED oracle for each test, and the mutants the
tests must kill. The design doc is the authority for *why*; read
docs/design/pack-registry-single-flight.md §1–§9 before starting a part, and the ADRs
566–571 in docs/adr/ for the decisions the design leaves open. Do **not** copy ADR,
phase or backlog numbers into source or test code — the commit is the join point.

### Surface gates — none owed

No public surface moves. `pack-registry.ts` is re-exported from neither
`src/application/primitives/index.ts` nor `src/index.ts`; `PackRegistry`,
`RegisteredPack` and `PackOffsetTable` appear zero times in `reports/api.json`. The one
new module lands in `src/application/primitives/internal/`, which is likewise
unbarrelled. **No `npm run docs:json` regeneration and no `reports/api.json` commit is
owed** — the pre-push `check:doc-typedoc` gate is untouched by this change. No new error
code, no `Repository` method, no barrel entry, no doc-coverage page, no browser-surface
scenario.

Gates that *do* apply, and where they are pre-paid:

- **ls-lint** — every new file is kebab-case (`promise-memo.ts`, `handle-ledger.ts`).
- **knip** (`check:dead-code`) — `knip.json` sets `ignoreExportsUsedInFile: true` and
  reaches `pack-registry.ts` through `read-object.ts` ← `primitives/index.ts`. The new
  helper is reachable only once a consumer imports it, so Part 1 lands the helper **and**
  its first consumer in one commit.
- **biome** — `biome.json` `files.includes` already whitelists `src/**` and `test/**`;
  no whitelist edit needed.
- **`check:test-pyramid`** — tier budgets are *shares*, not counts; one added unit file
  and zero added integration files keep every tier in band. The integration file's
  `@proves` header must keep its `unique:` value ≤ 200 characters (Part 3).
- **coverage** — `vitest.config.ts` scopes coverage to `src/domain`, `src/ports`,
  `src/adapters/{node,memory}`, `src/operators`. `src/application/**` is *not* in the
  coverage include, so the 100 % thresholds do not gate these files. Mutation does:
  `mutation-budgets.json` bucket `application` (`src/application/**`) breaks below 95.

### Why three parts share `pack-registry.ts`

`plan-lint` emits an advisory cognitive-locality warning when several parts declare the
same file. It is intentional here and the parts are **not** mergeable:

- Part 1 rewrites `loadPack`'s `offsetTable` (a leak-free memo, no ledger needed).
- Part 3 rewrites `createPackRegistry`'s scan memo plus `refresh`/`dispose` — the leak
  fix, and the only part whose tests need the gated-readdir ledger.
- Part 4 adds the two lifecycle rules (drain, terminal disposal) that ADR-568/569
  decided *on top of* Part 3's shape; they are additive, not a rewrite of it.

Merging them yields one part carrying 14 unit cases, a new fixture, a new src module and
a dist-building integration scenario — past the size where a single agent lands it in one
spawn.

### Planning-time correction to the integration oracle (read before Part 3)

ADR-571 and the design's test strategy specify the burst scenario asserting
`ACTIVE_HANDLES_DELTA=0` "against real Node fds". **That oracle cannot observe an open
`FileHandle`** — verified empirically at planning time on Node v22.22.3 (throwaway
script, no repo state touched): opening five `FileHandle`s and never closing them leaves
`process._getActiveHandles().length` unchanged at its baseline (delta 0 before and after
the opens, 0 after the closes). Node's `FileHandle` is an `AsyncWrap`, not a
`HandleWrap`, so it never enters the libuv handle queue that
`process._getActiveHandles()` walks. `process.getActiveResourcesInfo()` shows only the
transient `FSReqPromise`, not the descriptor.

Consequence: a burst scenario asserting only `ACTIVE_HANDLES_DELTA=0` would be **green
before the fix** — the exact blindness ADR-571 set out to remove.

The oracle that *does* observe it is the reported failure itself. Same environment, same
throwaway: dropping three open `FileHandle`s and forcing `global.gc()` emits, per
descriptor, `Warning: Closing file descriptor <n> on garbage collection`, plus one
`DEP0137 DeprecationWarning: Closing a FileHandle object on garbage collection is
deprecated. … In the future, an error will be thrown …`. That deprecation *is* the Node
26 hard error from the consumer report, in its Node ≤ 24 form. Counting warnings whose
message contains `garbage collection` in the child, after an explicit `global.gc()`,
gives an oracle that is:

- **red before the fix** — K−1 superseded pack sets hold open, unreachable handles;
- **green after it, deterministically** — after the fix no *open* handle is unreachable,
  so no GC-close warning can fire; the assertion is `=== 0`, so it cannot flake green→red;
- **cross-platform** — pure Node API, unlike the `lsof` variant ADR-571 rejected as
  option 3.

Part 3 therefore keeps everything ADR-571 chose (the file, the tier, the built entry
point, the `mkdtemp` repo, `git gc`, the baseline-delta measurement) and **adds** the
GC-warning counter as the fd-closure oracle, keeping `ACTIVE_HANDLES_DELTA` as the
event-loop-cleanliness assertion it actually is. The file's header comment, which today
claims the dispose scenario proves the handle is closed because
`process._getActiveHandles()` is empty, is corrected in the same part.

## Part 1 — Promise-memo helper, consumed by the pack offset table

### Context

**Decisions this part implements:** ADR-566 (shared internal helper, not two inline
memos), ADR-567 (clear-on-reject, identity-guarded, inside the helper), ADR-570 (the
invariant is codified as ADR + a doc-comment on the helper — no scanner, no CLAUDE.md
bullet). Design sections: §1 (pinned async semantics P2/P3/P4/P5), §4 (`offsetTable`
becomes single-flight), §9 (the invariant).

**New file — `src/application/primitives/internal/promise-memo.ts`.** Internal: not
exported from `src/application/primitives/index.ts`, not from `src/index.ts`, never
referenced by `reports/api.json`. Land it with its consumer in this same commit so knip
reachability holds. Sibling precedents for the size and style of this module:
`src/application/primitives/internal/bounded-map.ts` (30 lines, one exported function)
and `src/application/primitives/internal/concurrency-limiter.ts` (interface + factory
closure, FP-first, no classes).

Exact shape to land:

```ts
export interface PromiseMemo<T> {
  /** Join the in-flight initialization, or start one. */
  readonly get: () => Promise<T>;
  /** The memoised promise, or undefined when idle. Never starts one. */
  readonly peek: () => Promise<T> | undefined;
  /** Drop the memo, returning what it held (undefined when idle). */
  readonly clear: () => Promise<T> | undefined;
}

export function createPromiseMemo<T>(factory: () => Promise<T>): PromiseMemo<T> {
  let slot: Promise<T> | undefined;

  const get = (): Promise<T> => {
    if (slot !== undefined) return slot;
    const pending: Promise<T> = factory().catch((err: unknown) => {
      if (slot === pending) slot = undefined;
      throw err;
    });
    slot = pending;
    return pending;
  };

  return {
    get,
    peek: () => slot,
    clear: () => {
      const outgoing = slot;
      slot = undefined;
      return outgoing;
    },
  };
}
```

Load-bearing details, each of which a reviewer will look for:

- The slot is written **synchronously**, before any `await` — that is the whole fix
  (design §1 P2). `get` is a plain arrow, not `async`: both would install synchronously,
  but the plain form makes it structurally impossible to introduce an `await` above the
  assignment later.
- `const pending: Promise<T> = factory().catch(cb)` where `cb` closes over `pending` is
  TDZ-safe: `cb` cannot run before the current synchronous block finishes (design §1 P5,
  pinned empirically).
- `if (slot === pending)` is the identity guard. Without it, a predecessor that rejects
  after a `clear()` + re-`get()` erases the **successor** memo, whose packs then become
  unreachable from `refresh`/`dispose` — the same leak in a narrower window (design §1
  P3/P4). The house memos (`node-file-system.ts:510-528`,
  `internal/read-commit-graph.ts:179-189`) clear unconditionally; for them the worst case
  is one redundant re-resolve, which is why this helper deliberately diverges.
- The doc-comment on `createPromiseMemo` is the in-code beacon for the invariant: *any
  lazy initializer that crosses an `await` must memoise the promise, not the result; if
  the initialization owns a disposable, `dispose`/`refresh` must capture and await the
  pending promise before releasing it; a slot clearable by anything other than the
  initializer needs an identity-guarded clear.* Write it in those words. **No ADR number,
  no phase reference** in the comment.

**Consumer — `src/application/primitives/pack-registry.ts`, inside `loadPack`
(`:86-169`).** Current code at `:93-108`:

```ts
let cachedTable: PackOffsetTable | undefined;
const offsetTable = async (): Promise<PackOffsetTable> => {
  if (cachedTable !== undefined) return cachedTable;
  const stat = await ctx.fs.stat(packPath);
  const packFileSize = stat.size;
  const raw = entryOffsets(index);
  const sortedOffsets = [...raw].sort((a, b) => a - b);
  // The pack file trailer is a single pack-checksum digest (SHA-1: 20 bytes,
  // SHA-256: 32 bytes). The last entry's data ends exactly at trailerStart.
  const trailerStart = packFileSize - ctx.hashConfig.digestLength;
  if (trailerStart < 0) {
    throw invalidPackIndex('pack file too small to contain a trailer');
  }
  cachedTable = { sortedOffsets, packFileSize, trailerStart };
  return cachedTable;
};
```

becomes a `buildOffsetTable` factory whose body is the same statements with the two
`cachedTable` lines removed and a direct `return { sortedOffsets, packFileSize,
trailerStart };`, plus:

```ts
const offsetTable = createPromiseMemo(buildOffsetTable).get;
```

Keep the trailer comment verbatim, keep `entryOffsets(index)` **after** the
`await ctx.fs.stat(packPath)` (statement order is behaviour here — a `stat` that throws
must do so before any sorting work), and keep the returned object literal at `:168`
unchanged (`{ name, index, packPath, idxPath, offsetTable, readSlice, close }`).
`RegisteredPack.offsetTable` keeps its declared type `() => Promise<PackOffsetTable>`
(`:35`).

**Do not touch, in this part or any other:**

- `readSlice` (`:122-154`) — including the multi-line `// NOTE:` equivalent-mutant proof
  inside its `finally` block (`:141-151`). Preserve it **byte-for-byte**: do not reflow,
  re-wrap, re-indent or reword it, and do not move the `inFlight.delete(read)` statement
  it documents. (Edits elsewhere in the file shift its line number; that is harmless —
  it is prose, not a line-anchored directive.)
- `close` (`:156-166`), `bisectLeft` (`:171-183`), `nextOffsetForEntry` (`:185-196`).
  The file's one line-anchored Stryker directive lives at `:188`
  (`// Stryker disable next-line EqualityOperator: …`) and must remain the line
  immediately above `if (rank >= sortedOffsets.length || sortedOffsets[rank] !== offset)`.
- `readBoundedIdx` (`:71-84`), `isSafePackName`, `isCandidate`, the exported interfaces.

**Tests.** New file `test/unit/application/primitives/internal/promise-memo.test.ts`
(sibling style: `test/unit/application/primitives/internal/bounded-map.test.ts`).
Extend `test/unit/application/primitives/pack-registry.test.ts` in the existing
`describe('RegisteredPack.offsetTable', …)` family at `:398`.

Fixtures already in place, no new ones needed for this part:

- `buildSeededContext()` from `./fixtures.js` — returns a `Context` over the memory
  adapter.
- `writeSyntheticPack(ctx, name, entries)` from `./pack-fixture.js` →
  `Promise<ReadonlyArray<string>>` (the entry ids); writes
  `${ctx.layout.gitDir}/objects/pack/pack-<name>.{pack,idx}`. Entry spec for a plain
  blob: `{ kind: 'base', type: 'blob', content: <Uint8Array> }`.
- The stat-counting pattern U12 needs already exists verbatim at `:398-442`: build the
  pack, create a **second** registry over a ctx whose `fs.stat` increments a counter,
  `await registry2.all()`, then reset the counter to zero so `loadPack`'s own `stat` is
  not counted, then exercise `offsetTable`.

Existing cases that must stay green (requirement 7): `:309` negative-`trailerStart`
guard, `:357` zero-`trailerStart` boundary, `:398` stat-called-once, `:445`
sortedOffsets-ascending.

**Test conventions.** `describe('Given …')` > `describe('When …')` > `it('Then …')`;
`// Arrange` / `// Act` / `// Assert` sections, each non-empty; `sut` names the unit under
test (here: `createPromiseMemo`, and `pack.offsetTable` — never the result). Assert error
payloads through `try`/`catch` on `.data`, never `toThrow(SomeClass)` alone.

**Mutants this part must kill.** `slot !== undefined` early return (both arms);
`slot === pending` identity guard (both `ConditionalExpression` directions);
`clear()`'s `slot = undefined` assignment; the `offsetTable` memo's own installation.

### TDD steps

**RED 1 — `test/unit/application/primitives/internal/promise-memo.test.ts`.** Six cases;
before the module exists every one fails at import with `Cannot find module
'../../../../../src/application/primitives/internal/promise-memo.js'`. Use a
deferred-per-call factory (`const calls: Array<{ resolve; reject; promise }> = []`;
the factory pushes a new deferred entry and returns its promise) so each case controls
settlement order. Do not collapse these into `it.each` — the oracle shapes differ.

1. *Given an idle memo, When peek() is called, Then it returns undefined and the factory
   never ran* — asserts `peek` is non-installing.
2. *Given an idle memo, When 8 get() calls run under `Promise.all`, Then the factory ran
   exactly once and all 8 resolved values are the same object reference* (`toBe`).
   Expected failure before GREEN: module missing; after a naive result-memo
   implementation it would report 8 factory runs — that is the shape this pins.
3. *Given a memo whose flight is in progress, When peek() is called, Then it returns the
   same promise the first get() returned* (`toBe` on the promise).
4. *Given a populated memo, When clear() is called, Then it returns the outgoing promise,
   peek() is undefined afterwards, and the next get() runs the factory a second time.*
5. *Given a factory that rejects, When get() is awaited and get() is called again, Then
   the first await throws with `data.code === 'PERMISSION_DENIED'` (try/catch on `.data`,
   using `permissionDenied(path)` from `src/domain/error.js`) and the factory ran twice*
   — clear-on-reject, ADR-567.
6. *Given a memo whose first flight is still in progress, When clear() then get()
   installs a successor and the FIRST flight then rejects, Then peek() still returns the
   successor promise, awaiting it resolves to the successor's value, and the factory ran
   exactly twice across a following get()* — the identity guard. Attach a `.catch(() => {})`
   to the predecessor promise you deliberately reject so it does not surface as an
   unhandled rejection. Without the guard the successor slot is nulled and the following
   `get()` makes the factory run a third time.

**RED 2 — U12, `pack-registry.test.ts`, `describe('RegisteredPack.offsetTable')`.**
*Given a cold pack obtained from all() with the stat counter reset, When K=8
offsetTable() calls run under `Promise.all`, Then `ctx.fs.stat` was called exactly once
and all 8 results are the same object reference.* Expected failure against current code:
`statCallCount === 8`, and the first two results are distinct objects with equal fields
(`toBe` fails, `toEqual` would have passed — assert identity).

**RED 3 — U13, same family.** *Given a pack whose `stat` makes `trailerStart` negative,
When offsetTable() rejects and is called again, Then `stat` ran twice and the second
rejection carries `data.code === 'INVALID_PACK_INDEX'` with `data.reason` containing
`'pack file too small'`.* Honest labelling: this case is **green against current code**
(today's `cachedTable` simply stays `undefined` after the throw). It is authored here,
before the swap, precisely so the swap cannot silently start memoising rejections —
written afterwards it would prove nothing about the change. Reuse the size-overriding
`stat` wrapper from `:309-355` (`if (path.endsWith('.pack')) return { ...real, size: 10 }`).

**GREEN.** Write `promise-memo.ts` exactly as sketched above; convert `loadPack`'s
`offsetTable` to `createPromiseMemo(buildOffsetTable).get`. Nothing else changes.

**REFACTOR.** Confirm `buildOffsetTable`'s statement order matches the original; confirm
the helper doc-comment states the invariant in prose with no ADR/phase reference; run the
gate and check no existing `offsetTable` case regressed.

### Gate

```
npx vitest run test/unit/application/primitives/internal/promise-memo.test.ts test/unit/application/primitives/pack-registry.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/promise-memo.ts src/application/primitives/pack-registry.ts test/unit/application/primitives/internal/promise-memo.test.ts test/unit/application/primitives/pack-registry.test.ts
```

### Commit

```
perf: single-flight the pack offset table behind a shared promise memo
```

## Part 2 — Shared handle ledger replacing the hand-rolled counters

### Context

**Decision this part implements:** ADR-571's unit half — "the shared `handle-ledger.ts`
fixture, replacing five hand-rolled copies — makes every lifecycle-matrix row observable
through the `FileSystem` port, no fs module mocking." Design section: Test strategy →
Unit.

**Test-infra only — no `src/` delta.** That is what makes it a legitimate standalone
part: it has no implementation part to fold into, and Part 3 needs the seam already in
place to express `outstanding() === 0`, the acceptance criterion of requirement 2.

**New file — `test/unit/application/primitives/handle-ledger.ts`** (kebab-case per
ls-lint's `test:` rule; a plain `.ts` sibling of the existing `fixtures.ts` and
`pack-fixture.ts` in the same directory, so it is not picked up as a test file by
`vitest.config.ts`'s `test/unit/**/*.test.ts` include).

Surface to land **in this part** (the `readdirGate` arrives in Part 3, with its first
consumer — do not build it speculatively):

```ts
export interface HandleLedger {
  /** The wrapped Context to hand to createPackRegistry. */
  readonly ctx: Context;
  /** ctx.fs.openWithNoFollow call count. */
  readonly opens: () => number;
  /** Completed close() calls on handles this ledger handed out. */
  readonly closes: () => number;
  /** opens − closes: handles still open. */
  readonly outstanding: () => number;
  /** ctx.fs.readdir call count. */
  readonly readdirCalls: () => number;
  /** ctx.fs.readSlice call count — the per-call fallback path. */
  readonly perCallReads: () => number;
}

export function withHandleLedger(base: Context): HandleLedger;
```

Implementation notes:

- Wrap only `openWithNoFollow`, `readdir` and `readSlice`; spread the rest of `base.fs`
  through unchanged (`{ ...base, fs: { ...base.fs, … } }` — the established pattern in
  every test in `pack-registry.test.ts`). **No `vi.mock` of `node:fs`** — the seam is the
  `FileSystem` port.
- `openWithNoFollow` increments `opens` and returns `{ ...handle, close: async () => { await handle.close(); closes += 1; } }`. Count the close **after** the underlying close
  resolves, so `outstanding()` reads as "descriptors still open right now" — Part 4's
  drain assertion depends on that ordering.
- `FileHandle` (`src/ports/file-system.ts:34-48`) is `{ read, write, stat, close }`, all
  readonly — spreading and overriding `close` is exactly what the existing tests at
  `:721-736` and `:765-780` already do.
- Keep it dependency-free beyond `Context`, `FileHandle`, `DirEntry` type imports from
  `../../../../src/ports/…`.

**Migration sites in `test/unit/application/primitives/pack-registry.test.ts`** — five
hand-rolled ledgers to replace, assertions unchanged in every case:

| Site | Currently counts | Becomes |
|---|---|---|
| `:170-201` "Given a cached scan / When refresh()" | local `readdirCalls`, alongside `exists: async () => true` and a `readdir` stub returning `[]` | `ledger.readdirCalls()`, with both stubs moved *beneath* the ledger — see the layering rule below |
| `:600-639` "RegisteredPack retired reads" | local `opens` + `perCallReads` | `ledger.opens()` / `ledger.perCallReads()` |
| `:711-750` "PackRegistry.refresh" | local `closeCalls` | `ledger.closes()` |
| `:752-794` "PackRegistry.dispose / two packs" | local `closeCalls` | `ledger.closes()` |
| `:839-864` "dispose / no packs loaded" | local `readdirCalls` | `ledger.readdirCalls()` |

Leave `:796-837` ("Given a pack whose close() rejects") hand-rolled: it *injects* a
failing `close`, it does not count one, and giving the ledger a failure-injection knob
would add surface no test in this change needs.

Sites intentionally untouched: the `vi.spyOn(ctx.fs, 'openWithNoFollow')` uses at `:482`
and `:699` (a spy, already minimal), and the size-overriding `stat` wrappers at `:120`,
`:203`, `:309`, `:357`, which are behaviour injection, not accounting.

**Layering rule — get this wrong and a migrated test silently counts zero.** The ledger
counts a call only if that call routes through `ledger.ctx.fs`. So:

- a wrapper that **replaces** a method (a stub: `exists: async () => true`,
  `readdir: async () => []`) must sit **beneath** the ledger — pass the pre-stubbed
  context into `withHandleLedger`;
- a wrapper that **delegates** to the ledger's method may sit above it.

Concretely, site `:170-201` today forces `exists` true and stubs `readdir` to `[]`
(the seeded repo has no pack directory, so a real `readdir` would throw). It migrates to:

```ts
const ledger = withHandleLedger({
  ...ctx,
  fs: { ...ctx.fs, exists: async () => true, readdir: async (): Promise<ReadonlyArray<DirEntry>> => [] },
});
const sut = createPackRegistry(ledger.ctx);
```

with `expect(ledger.readdirCalls()).toBe(1)` / `toBe(2)` replacing the local counter.
Wrapping the *other* way round — stubbing `readdir` above the ledger — makes
`readdirCalls()` stay 0 and the migrated assertions vacuous. The other four sites wrap the
plain seeded `ctx` (`withHandleLedger(ctx)`), because they count calls that reach the real
memory adapter.

**Conventions.** The migrated tests keep their existing Given/When/Then titles, AAA
comments and `sut` bindings verbatim — this part changes *how* a count is obtained, never
what is asserted. A migrated test whose assertion had to change is a defect in the
migration, not an improvement: stop and escalate.

### TDD steps

**RED 1.** Point the five sites at `withHandleLedger(…)` first, honouring the layering
rule above. Every one of them fails at import: `Cannot find module './handle-ledger.js'`.
Run the gate to see it.

**RED 2.** Add one case proving the ledger's own arithmetic is not vacuous — *Given a pack
read once through the ledger, When `close()` has run, Then `outstanding()` was 1 before the
close and is 0 after* — because `outstanding()`'s `opens - closes` subtraction is what
Part 3's requirement-2 assertions rest on and would otherwise have no test of its own
(its `ArithmeticOperator` mutants would survive). Same import failure.

**GREEN.** Write `handle-ledger.ts` with exactly the surface above. Re-run: the five
migrated cases pass with their original assertions
(`expect(ledger.readdirCalls()).toBe(1)` / `toBe(2)`, `expect(ledger.opens()).toBe(1)`,
`expect(ledger.perCallReads()).toBe(1)`, `expect(ledger.closes()).toBe(1)` / `toBe(2)`,
`expect(ledger.readdirCalls()).toBe(0)`), and so does the new case.

**REFACTOR.** Delete every now-unused local counter declaration and `fs` wrapper at the
five sites; verify by reading the diff that no assertion *value* changed anywhere.

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/application/primitives/handle-ledger.ts test/unit/application/primitives/pack-registry.test.ts
```

### Commit

```
test: share one handle ledger across the pack-registry tests
```

## Part 3 — Single-flight pack scan; refresh and dispose capture the pending scan

### Context

This is the fix. **Decisions:** ADR-566 (consume the helper), ADR-567 (identity-guarded
clear-on-reject, inherited from the helper — no second copy here), ADR-571 (unit ledger +
concurrent-burst integration scenario). Design sections: §2 (`loadAll` becomes
single-flight), §3 (`refresh`/`dispose` capture the pending promise — *minus* the
`trackClose`/`drainPendingCloses`/`disposed` machinery, which is Part 4), §5 rows L1–L7,
L12–L14, §6 (error semantics), Requirements 1–5.

**The defect, in one sentence:** `createPackRegistry.loadAll`
(`src/application/primitives/pack-registry.ts:198-216`) memoises the **result**, and the
assignment `cache = packs` at `:214` lands after two awaits — so K concurrent first
callers each build their own `RegisteredPack` set, each opens its own persistent
`FileHandle` through `readSlice` (`:125`), and `refresh`/`dispose` only ever close the
one set that won the race. The K−1 superseded sets are unreachable from any tsgit code
path, so only the GC can close their descriptors — the condition Node 26 makes a hard
error. A second defect falls out of the same shape: `cache = packs` runs
unconditionally, so a `refresh()` issued during an in-flight scan is silently undone.

**src change — `src/application/primitives/pack-registry.ts:198-252`.** Current:

```ts
export function createPackRegistry(ctx: Context): PackRegistry {
  let cache: ReadonlyArray<RegisteredPack> | undefined;
  async function loadAll(): Promise<ReadonlyArray<RegisteredPack>> { … }
  return { all: loadAll, refresh(): void { … }, async lookup(id) { … }, async dispose() { … } };
}
```

Land:

```ts
const NO_PACKS: ReadonlyArray<RegisteredPack> = [];   // module scope

export function createPackRegistry(ctx: Context): PackRegistry {
  const scanPacks = async (): Promise<ReadonlyArray<RegisteredPack>> => {
    const dir = packsDir(commonGitDir(ctx));
    if (!(await ctx.fs.exists(dir))) return NO_PACKS;
    const entries = await ctx.fs.readdir(dir);
    const packs: RegisteredPack[] = [];
    for (const entry of entries) {
      if (!isCandidate(entry)) continue;
      packs.push(await loadPack(ctx, dir, entry.name));
    }
    return packs;
  };
  const scan = createPromiseMemo(scanPacks);

  return {
    all: scan.get,
    refresh(): void {
      // The outgoing packs may hold open persistent handles; close them before
      // dropping the references or every refresh leaks one fd per touched pack.
      const outgoing = scan.clear();
      if (outgoing === undefined) return;
      void outgoing.then(
        (packs) => Promise.allSettled(packs.map((pack) => pack.close())),
        // A rejected scan produced no packs and therefore no handles. The error is
        // not discarded: it is delivered to the all()/lookup() caller that triggered
        // the scan — this arm only declines to close a set that does not exist.
        () => NO_PACKS,
      );
    },
    async lookup(id: ObjectId): Promise<PackLookupHit | undefined> {
      const packs = await scan.get();
      for (const pack of packs) { … unchanged … }
      return undefined;
    },
    async dispose(): Promise<void> {
      // A registry that never scanned the pack directory has no handles to close.
      const pending = scan.peek();
      if (pending === undefined) return;
      const packs = await pending.catch(() => NO_PACKS);
      const results = await Promise.allSettled(packs.map((pack) => pack.close()));
      const failure = results.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      if (failure !== undefined) throw failure.reason;
    },
  };
}
```

Each property is load-bearing (design §2/§3):

- `scanPacks` **never writes the memo.** The only writers are the helper's install and
  `refresh`'s `clear()`. That is what makes requirement 3 hold: a scan completing after a
  `refresh()` has nothing to re-populate.
- The empty-directory arm **returns** `NO_PACKS` instead of assigning it. `all()` still
  resolves to an empty array, and the memo now holds a resolved promise of it, so a later
  `dispose()` sees a populated memo and closes an empty set — a no-op, matching today.
- `dispose` uses `peek()`, **not** `clear()`: ADR-569 keeps `all()` returning the closed,
  retired set after disposal exactly as today.
- Neither `refresh` nor `dispose` swallows an error. Each scan rejection has exactly one
  owner — the `all()`/`lookup()` caller that triggered it. Both handlers exist solely so a
  second, ownerless subscription does not become an unhandled rejection. A scan rejection
  escaping `dispose()` would be actively harmful: `repository.dispose()`
  (`src/repository.ts:466-491`) runs in consumers' `finally` blocks, where it would mask
  the original failure.
- **A pack that never escapes the scan can never have opened a handle.**
  `openWithNoFollow` is reachable only from `readSlice` (`:125`), reachable only through
  the array `scanPacks` returns; `loadPack` performs `stat` + `read` + `parsePackIndex`
  and opens nothing. So a mid-loop rejection discards a partially-built array with zero
  descriptors outstanding — which is why clear-on-reject needs no partial cleanup.
- Keep `refresh(): void` synchronous. It is `refresh(): void` on the `PackRegistry`
  interface (`:57`) and is called from synchronous contexts:
  `src/application/primitives/read-object.ts:40` (`refreshPackRegistry`) and
  `read-object.ts:119` (the lazy-fetch retry after a promisor fetch writes a new pack).
- **`NO_PACKS` is used in all three places** — the empty-directory arm, `refresh`'s
  rejection arm, `dispose`'s absorb arm. The design's §2/§3 sketches mix a bare `[]` with a
  `NO_PACKS` constant; consolidating on the named constant is behaviour-identical and makes
  its `ArrayDeclaration` mutant killable twice over (by the existing "missing pack
  directory ⇒ `all()` returns `[]`" case at `:42-55` and by U8).
- **No caller changes.** `read-object.ts`'s `getPackRegistry` / `refreshPackRegistry` /
  `disposePackRegistry` (`:24-49`) and `fetch-missing.ts:65`'s standalone registry keep
  working unchanged — the `PackRegistry` interface is untouched, only its implementation.

Same do-not-touch list as Part 1: `readSlice` and its `// NOTE:` proof comment
byte-for-byte, `close`, `bisectLeft`, `nextOffsetForEntry` and the Stryker directive
above its guard, `loadPack`'s body other than what Part 1 already changed.

**Ledger extension — `test/unit/application/primitives/handle-ledger.ts`.** Add the
per-call readdir gate (design's Test strategy; per-call, not one shared gate, because U7
needs two scans in flight simultaneously and must settle them in a chosen order):

```ts
export interface ReaddirGate {
  /** Resolves when readdir call #n reaches the gate. */
  readonly arrived: (call: number) => Promise<void>;
  /** Release call #n; it then performs the real readdir. */
  readonly settle: (call: number) => void;
  /** Reject call #n with `error`. */
  readonly fail: (call: number, error: unknown) => void;
}
export function withHandleLedger(base: Context, opts?: { gateReaddir?: boolean }): HandleLedger;
// HandleLedger gains: readonly readdirGate: ReaddirGate;
```

Implementation: two deferred promises per call index, created on demand (so `settle(n)`
may be called before call n arrives, and `arrived(n)` may be awaited before it happens).
The wrapped `readdir` takes the next index, resolves that index's *arrival* deferred,
awaits its *release* deferred, then returns `base.fs.readdir(path)`. `fail(n, error)`
rejects the release deferred, so the readdir itself rejects with that error. `arrived` is
what makes U4/U5/U7 deterministic without polling or `setTimeout` — do not substitute
sleeps.

**Unit tests — extend `test/unit/application/primitives/pack-registry.test.ts`.** Ten new
cases, all observing through the ledger or a return value; none inspects the private memo.
Do not merge different oracle shapes into `it.each`. Put them under a new top-level
`describe('PackRegistry — single-flight scan')` wrapper (a non-GWT module-name wrapper is
allowed as a transparent outer layer) with `Given …` / `When …` / `Then …` beneath it, next
to the file's existing `describe('PackRegistry.refresh')` and
`describe('PackRegistry.dispose')` families. Ids for `lookup` come from
`writeSyntheticPack`'s return value and are cast at the call site (`ids[0] as ObjectId`),
as the file already does at `:63`.

| # | Given / When / Then | RED against current code |
|---|---|---|
| U0 | Given a registry that never scanned, When `refresh()` is called, Then it neither throws nor triggers a `readdir` or a `close` (`readdirCalls() === 0`, `closes() === 0`) | green today, but mandatory: it is the only case that kills `refresh`'s `outgoing === undefined` guard forced to `false`, where `undefined.then(…)` throws synchronously out of a `void` method |
| U1 | Given a cold registry over a repo with 2 packs, When K=8 `all()` calls run under `Promise.all`, Then `readdirCalls() === 1` and every returned array is the same reference | `readdirCalls() === 8`, 8 distinct arrays |
| U2 | Given the same repo, When K=8 `lookup(id)` calls run concurrently on an id returned by `writeSyntheticPack`, Then every hit carries the identical `pack` reference and `readdirCalls() === 1` | `readdirCalls() === 8`, distinct `pack` objects |
| U3 | Given U1's burst, When **each of the 8 callers reads every pack in its own result** (`await Promise.all(result.map((pack) => pack.readSlice(0, 4)))`) and `dispose()` is awaited, Then `opens() === 2` and `outstanding() === 0` | `opens() === 16` (8 sets × 2 packs), `outstanding() === 14` — only the winner's two get closed. **This is the reported crash in unit form**. Every caller must read every pack, not one apiece: reading one apiece gives 8 opens pre-fix and 2 post-fix, which still fails but no longer states the leak's true size |
| U4 | Given a gated scan (call 0) in flight, When `refresh()` runs, call 0 is settled, the original caller then `readSlice`s, and `all()` is called again, Then `readdirCalls() === 2` and `opens() === 0` | `readdirCalls() === 1` (the completing scan re-populated the memo) and `opens() === 1` |
| U5 | Given a gated scan (call 0) in flight, When `dispose()` is started, call 0 is then settled and the disposal awaited, Then an order log reads `['scan-settled', 'dispose-resolved']`, and a later `readSlice` by the scan's caller leaves `opens() === 0`, `outstanding() === 0` | `dispose()` resolves first having closed nothing; the later `readSlice` opens a handle nothing will ever close (`outstanding() === 1`) |
| U6 | Given a gated scan whose call 0 is failed with `permissionDenied(dir)`, When `all()` is awaited, Then the error's `data.code === 'PERMISSION_DENIED'` (try/catch on `.data`) and a second `all()` re-scans (call 1, settled) resolving normally | passes today too — pins that the memo swap keeps rejections retryable (ADR-567) |
| U7 | Given gated scans, When `p1 = all()` (call 0) → `await arrived(0)` → `refresh()` → `p2 = all()` (call 1) → `await arrived(1)` → `fail(0, err)` → `settle(1)`, Then `p1` rejects, `p2` resolves, and a third `all()` performs no further scan (`readdirCalls() === 2`) | the identity guard's own case: without it the third `all()` scans (`=== 3`) |
| U8 | Given a gated scan whose call 0 is failed, When `dispose()` is awaited concurrently, Then it resolves without throwing and `closes() === 0` | `dispose()` sees `cache === undefined` and returns — green today, red under a naive port that lets the rejection escape `dispose` |
| U9 | Given a gated scan that is failed while a `refresh()` ran during it, When one macrotask has passed, Then a `process.on('unhandledRejection')` listener installed in Arrange (removed in `finally`) was never called | the `() => NO_PACKS` arm of `refresh` |

Mechanics worth pre-chewing:

- **U5's order log.** `const p1 = sut.all(); await gate.arrived(0);` then register
  `const scanDone = p1.then(() => { order.push('scan-settled'); });` and
  `const disposal = sut.dispose().then(() => { order.push('dispose-resolved'); });`, then
  `gate.settle(0)`, then `await Promise.all([scanDone, disposal])`. Deterministic:
  `dispose` awaits the pending scan and then a full `allSettled` of closes, so its
  resolution is strictly later than the scan's.
- **U7's call indices** are deterministic only because `arrived(0)` is awaited before
  `p2` starts. Do not skip it.
- **U9** must attach a handler to the promise it deliberately rejects (`p1.catch(() => {})`)
  or the *test's own* `all()` rejection becomes the unhandled rejection it is checking for.
  Let one macrotask pass (`await new Promise((resolve) => setTimeout(resolve, 0))`) before
  asserting; Node reports unhandled rejections only after a full microtask drain.
- U1/U2/U3 build two packs via two `writeSyntheticPack(ctx, 'burst-a' | 'burst-b', [{ kind: 'base', type: 'blob', content }])`
  calls before creating the registry; `writeSyntheticPack` returns the entry ids U2 needs.
- `readSlice(0, 4)` is the established minimal read in this file.

Existing cases that must stay green: every case in the file (requirement 7) — retired-pack
per-call fallback (`:600`), `UNSUPPORTED_OPERATION` browser fallback and its
reset-and-retry (`:516`), `refresh()` closes outgoing packs (`:711`), `dispose()` rethrows
the first close rejection (`:796`), `dispose()` without a prior scan touches no `fs`
(`:839`), `isSafePackName` filtering (`:71`), both `MAX_PACK_IDX_BYTES` guards (`:120`,
`:203`), `close()` idempotence and its `inFlight` drain (`:642`, `:665`).

**Integration scenario — `test/integration/dispose-free-exit.test.ts`.** Read the
"Planning-time correction to the integration oracle" section at the top of this plan
first; it is load-bearing and it revises the oracle ADR-571 named.

Changes to that file:

1. `childScript` gains a GC-close-warning counter, installed **before** the repo is
   opened:
   ```js
   const gcClosedFds = [];
   process.on('warning', (warning) => {
     if (warning.message.includes('garbage collection')) gcClosedFds.push(warning.message);
   });
   ```
   Node emits one `Warning: Closing file descriptor <n> on garbage collection` per
   collected open `FileHandle`, plus one `DEP0137` deprecation; both contain the phrase,
   both are zero after the fix, so counting either is correct and counting both is
   simplest.
2. A third `mode`, `'burst'`: `const BURST = 64;` then
   `await Promise.all(Array.from({ length: BURST }, () => repo.diff({ from: 'HEAD~1', to: 'HEAD' })));`
   — one `openRepository` and therefore one `Context`, one pack registry
   (`read-object.ts:15-30` memoises it in a `WeakMap<Context, PackRegistry>`), so the
   burst is K concurrent callers of one `loadAll`: the exact shape of the report. Then
   `await repo.dispose();`, then force collection —
   `global.gc(); await new Promise((r) => setTimeout(r, 50)); global.gc(); await new Promise((r) => setTimeout(r, 50));`
   — then report `GC_CLOSED_FDS=<count>` and `ACTIVE_HANDLES_DELTA=<delta>` and `DONE`.
   The two existing modes run without `--expose-gc`, so branch on the mode, and in burst
   mode **fail loudly** rather than silently: if `typeof global.gc !== 'function'`, write
   `GC_UNAVAILABLE` instead of a count. Without that, a child launched without the flag
   would report `GC_CLOSED_FDS=0` and the scenario would pass vacuously — the same class
   of blindness this correction exists to remove.
3. The new `it` runs the child as
   `execFileAsync(process.execPath, ['--expose-gc', scriptPath, repoDir, 'burst'], { timeout: BURST_TIMEOUT_MS })`.
   Node options are consumed before the script path, so `process.argv[2]`/`[3]` still hold
   `repoDir`/`mode`. Add `const BURST_TIMEOUT_MS = 30_000;` — `EXIT_TIMEOUT_MS` is the
   no-dispose exit budget and must keep meaning exactly that; a 64-way burst plus two
   forced GCs needs its own budget.
4. Assertions: `expect(stdout).toContain('GC_CLOSED_FDS=0')` **and**
   `expect(stdout).toContain('ACTIVE_HANDLES_DELTA=0')` **and** `toContain('DONE')`, with
   a comment recording that the delta proves event-loop cleanliness, **not** descriptor
   closure — `FileHandle` is an `AsyncWrap`, not a `HandleWrap`, so it never enters the
   queue `process._getActiveHandles()` walks.
5. Correct the file's header comment, which currently claims the second scenario "proves
   an explicit `dispose()` actually closes the persistent handle
   (`process._getActiveHandles()` is empty afterwards)". Replace that clause with the
   accurate split: the delta proves nothing is left referencing the event loop; the
   GC-close-warning count is what proves the descriptors were closed.
6. `@proves` header — extend the `unique:` line to
   `dispose-free-exit — persistent per-pack handles never keep the event loop alive; explicit dispose() closes them; a concurrent read burst orphans no handle to the GC`
   (164 characters, inside the manifest's `uniqueMaxLength: 200` in
   `test-pyramid-budgets.json`). `surface:` and `bucket:` stay as they are — no new file,
   so no tier-budget entry is owed.
7. Raise `BUILD_TIMEOUT_MS` from `120_000` to `600_000`. It is both the `execFile` timeout
   for `npm run build` and the `beforeAll` hook timeout; a dist-building hook needs the
   600 000 ms class (the file's `afterAll` already uses it).

Title for the new case: `describe('Given a repo whose objects are packed')` (existing) >
`describe('When a child process opens it, runs a concurrent read burst, and calls dispose()')`
> `it('Then no handle is left for the GC to close and no active handles remain')`.

**Lifecycle rows needing no new case.** §5's L9 (`dispose()` twice), L10 (`refresh` and
`dispose` closing the same pack concurrently) and L12 (`readSlice` in flight when its pack
is closed) are properties of `RegisteredPack.close`, which this change does not touch, and
are already covered at `:642-662` and `:665-709`. L13 (`dispose()` on a registry that never
scanned) is `:839-864`. L14 (`refresh()` twice while one scan is pending) falls out of U4
plus U0: the second `refresh()` sees an already-cleared memo and returns.

**Mutants this part must kill** (design's Mutation section): the memo's `!== undefined`
early return — U1 plus the existing "second `all()` is cached" case (`:170-201`) cover
both arms; `refresh`'s `outgoing === undefined` guard — the existing refresh case (`:711`)
kills the `→ true` direction, U0 kills `→ false`; `dispose`'s `pending === undefined`
guard — the existing "no packs loaded ⇒ no readdir" case plus U5; `NO_PACKS`'s
`ArrayDeclaration` mutant — the existing "missing pack directory" case (`:42-55`) and U8
(a non-empty `NO_PACKS` makes `pack.close` undefined and `dispose()` throw). The identity
guard itself is **not** re-tested here: it lives once, in the helper, killed by Part 1's
case 6 — that asymmetry is the concrete payoff of ADR-566 over two inline memos.

### TDD steps

**RED 1 — the integration burst scenario, written and run before any `src/` edit.** This
is the only moment in the whole change at which it can be genuinely red. Expected
failure: `GC_CLOSED_FDS=<n>` with n ≥ 1 (typically in the tens — one per superseded pack
set that opened a descriptor), so `expect(stdout).toContain('GC_CLOSED_FDS=0')` fails. If
it comes back green, **stop and escalate** — either the burst is not producing concurrent
first scans (raise `BURST`, confirm one `openRepository` call) or the oracle is not
firing (verify against a scratch child in a mktemp dir that opens a `FileHandle`, drops
it and forces GC: it must report a non-zero count). Do not weaken the assertion to make
the part proceed.

**RED 2 — the ledger's `readdirGate`.** Extend `handle-ledger.ts` and its first consumers
(U4/U5/U7) together; before the gate exists the new cases fail to type-check /
`readdirGate is undefined`.

**RED 3 — U0 … U9** in `pack-registry.test.ts`, each with the failure recorded in the
table above. Run them against unmodified `src/` and confirm each fails for the stated
reason, not an incidental one (a case failing on a fixture mistake proves nothing). U0,
U6 and U8 are green from the start by design — they are regression pins on behaviour the
rewrite must preserve, and each is labelled as such in the table.

**GREEN.** Land the `src/application/primitives/pack-registry.ts` rewrite exactly as
sketched: `scanPacks` extracted, `createPromiseMemo` installed, `all: scan.get`,
`lookup` awaiting `scan.get()`, `refresh` clearing and chaining, `dispose` peeking and
awaiting. Nothing outside `createPackRegistry` and the new module-scope `NO_PACKS`
changes.

**REFACTOR.** Re-read the diff against the do-not-touch list (the `// NOTE:` proof block,
the Stryker directive, `close`, `readSlice`). Confirm `refresh` is still declared
`refresh(): void`. Confirm both absorb-arms carry the "the error has an owner" comment in
prose, with no ADR number. Run the full unit file plus the integration file.

`dist/` is git-ignored (`.gitignore:5`): the `beforeAll` build is a side effect of running
the integration file, never part of the commit. Commit source, test and fixture files only.

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts test/integration/dispose-free-exit.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts test/unit/application/primitives/handle-ledger.ts test/unit/application/primitives/pack-registry.test.ts test/integration/dispose-free-exit.test.ts
```

Allow this command several minutes: the integration file's `beforeAll` runs
`npm run build`.

### Commit

```
fix: single-flight the pack directory scan so no FileHandle is orphaned
```

## Part 4 — dispose drains refresh-initiated closes and is terminal

### Context

**Decisions:** ADR-568 (`dispose()` drains `refresh()`'s fire-and-forget close batches)
and ADR-569 (`dispose()` is terminal — `refresh()` becomes a no-op after it). Design
sections: §3 (the `trackClose` / `drainPendingCloses` / `disposed` machinery deferred out
of Part 3), §5 rows L8 and L11, Requirement 2 ("zero outstanding handles **at the moment
`dispose()` resolves**").

Why these are additive rather than a rewrite of Part 3: `refresh()` gains one guard and
wraps its existing chain; `dispose()` gains one assignment and two drain points. Part 3's
shape is otherwise unchanged.

**src change — `src/application/primitives/pack-registry.ts`, `createPackRegistry` only.**
Add to the closure, above the returned literal:

```ts
  let disposed = false;
  const pendingCloses = new Set<Promise<unknown>>();

  // Only ever handed a promise that cannot reject (Promise.allSettled never does),
  // or this bookkeeping .finally would become an unhandled rejection of its own.
  const trackClose = (settled: Promise<unknown>): void => {
    pendingCloses.add(settled);
    void settled.finally(() => {
      pendingCloses.delete(settled);
    });
  };

  const drainPendingCloses = async (): Promise<void> => {
    await Promise.all([...pendingCloses]);
  };
```

`refresh()` becomes:

```ts
    refresh(): void {
      if (disposed) return;
      const outgoing = scan.clear();
      if (outgoing === undefined) return;
      trackClose(
        outgoing.then(
          (packs) => Promise.allSettled(packs.map((pack) => pack.close())),
          () => NO_PACKS,
        ),
      );
    },
```

`dispose()` becomes:

```ts
    async dispose(): Promise<void> {
      disposed = true;
      const pending = scan.peek();
      if (pending === undefined) return drainPendingCloses();
      const packs = await pending.catch(() => NO_PACKS);
      const results = await Promise.allSettled(packs.map((pack) => pack.close()));
      await drainPendingCloses();
      const failure = results.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      if (failure !== undefined) throw failure.reason;
    },
```

Details that decide correctness:

- `disposed = true` sits **before the first `await`**, so a `refresh()` interleaved
  anywhere inside `dispose()` is already gated (design §3).
- The `pending === undefined` arm **must still drain**: `refresh()` clears the memo, so
  after a refresh `peek()` is `undefined` while that refresh's close batch is still in
  flight. That arm is exactly the L8 path U10 exercises — returning bare would leave a
  descriptor closing after `dispose()` resolved.
- The drain snapshots (`[...pendingCloses]`). A close registered *during* the drain is
  therefore not awaited — unreachable, because the only `trackClose` caller is
  `refresh()`, which is gated on `disposed`.
- `refresh()` stays `void` and synchronous. ADR-568 explicitly rejected making it async
  (a breaking change to a public `void` method that pushes the burden onto every caller).
- ADR-569 keeps `all()` returning the closed, retired set after disposal; reads through it
  take `readSlice`'s per-call fallback (`:123`), so nothing observable changes for a
  consumer that (incorrectly) reads after disposal.

**Tests — `test/unit/application/primitives/pack-registry.test.ts`.**

| # | Given / When / Then | RED against Part 3's code |
|---|---|---|
| U10 | Given a pack read once (handle open) and then `refresh()`ed, When `dispose()` is awaited, Then `outstanding() === 0` and `closes() === 1` **at the moment `dispose()` resolves** | `dispose()` sees `peek() === undefined` and returns immediately while the refresh batch is still closing: `outstanding() === 1`, `closes() === 0` |
| U11 | Given a disposed registry whose pack was read once, When `refresh()` then `all()` then `readSlice` run, Then `readdirCalls()` and `opens()` are both unchanged from their pre-`refresh()` values | `refresh()` clears the memo, the next `all()` re-scans (`readdirCalls()` 1 → 2) and the read opens a handle nothing will ever close (`opens()` 1 → 2) |

U10's RED is microtask-order sensitive on a fast close path. **Make it unambiguous**:
wrap the ledger's ctx once more so the handle's `close` takes a real turn —
`{ ...ledger.ctx, fs: { ...ledger.ctx.fs, openWithNoFollow: async (p, m) => { const handle = await ledger.ctx.fs.openWithNoFollow(p, m); return { ...handle, close: async () => { await new Promise((r) => setTimeout(r, 5)); await handle.close(); } }; } } }`.
The ledger stays the inner layer, so it still counts the completion. With the drain in
place the test is deterministic in both directions.

**Also in this part — make the existing refresh case deterministic.** The
`describe('PackRegistry.refresh')` case at `:711-750` currently waits a macrotask
(`await new Promise((resolve) => setTimeout(resolve, 0))`) for the fire-and-forget close.
ADR-568's consequence is that it can now `await registry.dispose()` instead, which is
deterministic. Make that swap; keep the assertion (`closes() === 1`) unchanged. This is a
strict improvement, not a rewrite — if the assertion has to change, stop and escalate.

**Mutants this part must kill.** `if (disposed) return` in `refresh`, in both directions,
each by a different case — do not assume one test covers both:

- `→ false` (guard never fires) re-arms a disposed registry: U11 sees the re-scan in
  `readdirCalls()` and the unowned handle in `opens()`. The `disposed = true`
  `BooleanLiteral` mutant lands in the same place and is killed the same way.
- `→ true` (guard always fires) makes `refresh()` a permanent no-op. U11 still passes, and
  so does the `:711` refresh case after this part's swap — with the memo never cleared,
  `dispose()` closes the pack itself and `closes() === 1` holds anyway. The case that
  kills it is the existing `:170-201` "the next `all()` re-scans": an un-cleared memo
  leaves `readdirCalls()` at 1 where it expects 2.

The
whole drain machinery reduces to U10: it takes the `pending === undefined` arm, so
`ConditionalExpression` on that guard, `ArrowFunction` on `drainPendingCloses`,
`ArrayDeclaration` on its `[...pendingCloses]` snapshot and `BlockStatement` on
`trackClose`'s body all make U10's `outstanding() === 0` fail. Note that
`await drainPendingCloses()` in the *main* arm needs no case of its own — a bare statement
is not a Stryker mutation target, and every mutable expression inside the drain is already
covered through the `pending === undefined` path. Do **not** manufacture a
`refresh()` → `all()` → `dispose()` case to "cover" it: its redness would depend on the
refresh batch still being in flight after an intervening re-scan, which is a race, not an
oracle.

**Expected surviving mutant, do not pre-suppress.** `pendingCloses.delete(settled)` inside
`trackClose`'s `.finally` is very likely equivalent: a set that never shrinks makes
`drainPendingCloses` await already-settled promises, which changes no observable outcome —
only how long references live. Leave it alone here. If it survives the mutation phase,
triage it there with a proof comment anchored on the **expression** line, per the repo's
procedure; never a block-level suppression, and never a suppression added pre-emptively in
this part.

### TDD steps

**RED.** Write U10 (with the slow-close wrapper) and U11 in
`test/unit/application/primitives/pack-registry.test.ts`; run them against Part 3's
`src/` and confirm the two failures recorded in the table — `outstanding() === 1` for
U10, `readdirCalls()` incremented for U11. Then swap the `:711` refresh case's
`setTimeout` wait for `await registry.dispose()` and observe it fail too (without the
drain, the close has not completed when `dispose()` resolves).

**GREEN.** Add `disposed`, `pendingCloses`, `trackClose`, `drainPendingCloses`; the
`if (disposed) return` guard in `refresh`; `trackClose(...)` around its chain;
`disposed = true`, `return drainPendingCloses()` and `await drainPendingCloses()` in
`dispose`. Nothing else.

**REFACTOR.** Confirm `trackClose` is only ever handed a `Promise.allSettled` chain (its
one call site). Confirm the drain's snapshot spread is present. Confirm no comment carries
an ADR or phase number. Re-run the whole unit file — every case from Parts 1–3 plus the
pre-existing suite must be green.

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts test/unit/application/primitives/pack-registry.test.ts
```

### Commit

```
fix: drain refresh-initiated pack closes and make dispose terminal
```

## Phase gate

After Part 4, the phase-boundary run is `npm run validate`. Expect it to exercise, beyond
the part gates: `check:dead-code` (the new internal module must be import-reachable),
`check:test-pyramid` (tier shares plus the `@proves` header's `unique:` length),
`check:architecture`, `check:spelling`, and the full unit + integration suites. No
`reports/api.json` regeneration is owed by this change — see "Surface gates — none owed"
above — but the pre-push hook still runs `check:doc-typedoc`, so a stale report from an
unrelated source would surface there, not here.
