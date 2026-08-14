# Plan — cold-read first-access

> Source: design doc `docs/design/cold-read-first-access.md` · ADRs `635`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

**Why Parts 1 and 2 both declare `src/application/primitives/pack-registry.ts`, and
must stay separate.** They are two independent behavioural changes that happen to live
in one file. Part 1 is a **pure deferral** — the same faults reach the same consumers,
only later; nothing observable changes except cost and which memo forces what. Part 2
**changes an observable refusal**: a pack directory whose listing is refused stops
denying a loose read (design row C4/E5), and it is the only part whose interop suite
contains an assertion that fails on `main`. Merging them would put a perf refactor and
a git-faithfulness divergence closure behind one review surface and one commit, and
would make bisecting a regression to either one impossible. The ordering constraint is
one-directional and hard: Part 2's headline interop row cannot land before Part 1.

**Why `test/bench/loose-read.bench.ts` is named in both Part 4 and Part 5.** Only
Part 4 **edits** it. Part 5 merely **cites** it, because the methodology bullet it adds
to `docs/understand/performance.md` has to name the scenario it is explaining. Nothing
to merge; Part 5 must not touch any file under `test/`.

## Shared preamble — read before any part

**Ratified decisions (settled 2026-08-14; do NOT re-open).** DC-1 (a) split
`createPackRegistry` into a `storeGate` memo + the existing `scan` memo. DC-2 (b) the
node shim hands its already-resolved roots down as a pre-resolved root set — a data
hand-off, never a caller-settable flag, and never reachable from
`OpenRepositoryOptions`. DC-3 (a) the two midx presence probes stay strictly
sequential — **no change**. DC-4 (c) a companion bench scenario **and** a methodology
note; the existing scenario stays unchanged. DC-5 (a) one ADR, already written and
committed — **no further ADR work**. DC-6 (a) `openRepository` stays eagerly
constructed — **do not plan or attempt facade laziness**. DC-7 (b)
`docs/perf/hot-paths.json` stays unchanged — **do not edit it**.

**Property tests: deliberately none.** The design applied CLAUDE.md's four lenses
(round-trip pair / compositional matcher / total function over a grammar /
idempotence) and concluded none fits: this change is memo lifecycle and call
ordering, not a parser, matcher, round-trip pair or algebraic grammar. No
`*.properties.test.ts` sibling is warranted anywhere in this plan. This negative is
recorded here so the review pass does not flag the gap as an omission.

**Public-surface decision, made up front.**

- **Parts 1, 2, 4 and 5 introduce no PUBLIC symbol.** The seam lives entirely in
  `src/application/primitives/` and `src/application/primitives/internal/`, which are
  fully internal (`docs/use/primitives/internals.md` states this; nothing under
  `internal/` appears in `reports/api.json`). Part 1 does add exactly one new
  **module-internal** export — `EMPTY_MIDX_LOAD` from
  `src/application/primitives/internal/pack-generation.ts` — consumed only by
  `pack-registry.ts` in the same directory tree; it is internal by that rule, and
  `check:dead-code` only flags exports with **no** consumer, so it trips nothing.
  Verified for these four parts: no new error code, no new union member, no new
  Tier-1 command, no barrel entry, no `Repository` facade change, no `reports/api.json`
  delta. **Do not chase surface gates in these parts — they do not apply.**
- **Part 3 DOES touch public surface, and the design's blanket "no `reports/api.json`
  entry changes" sentence was scoped to the seam (§3.5), not to §4/DC-2.** Verified
  empirically: `NodeFileSystem` is exported from the `@scolladon/tsgit/adapters/node`
  entry and its **constructor's full parameter list is recorded in
  `reports/api.json`** (`rootDir`, `pathPolicy`, `fsOps`, each with its type). Adding
  a parameter changes that file. `reports/api.json` staleness is a **prepush** gate
  (`check:doc-typedoc` = `git diff --exit-code -- reports/api.json`, depends on
  `docs:json`), NOT a `validate` gate — local validate can be green while the push
  hook rejects. Part 3 therefore pre-pays it in-part: `npm run docs:json` then commit
  the regenerated `reports/api.json`.

**Coverage scope (matters for Part 3 only).** `vitest.config.ts` gates 100 %
statements/branches/functions/lines over `src/domain/**`, `src/ports/**`,
`src/adapters/node/**`, `src/adapters/memory/**`, `src/operators/**`.
`src/application/primitives/**` and `src/index.node.ts` are **outside** that scope
(Stryker still mutates all of `src`). So Parts 1/2 owe no coverage-threshold work,
while **every new branch Part 3 adds to `src/adapters/node/node-file-system.ts` must
be 100 % covered by unit tests, both arms**.

**Gate hygiene (repo-specific, learned the hard way).** Run each gate command **bare**
and check `$?` before chaining a commit — a `| tail` pipe has masked a red run twice
on this repo. Any `beforeAll` in `test/integration` that spawns `git` needs an
explicit `60_000` timeout (the 10 s default fails under full-validate concurrency).

---

## Part 1 — Split the pack registry into a store gate and a deferred scan

### Context

**Goal.** `assertLoadable()` must await ONLY the multi-pack-index load. The
`objects/pack` directory listing, `fileNames`, candidate `RegisteredPack`
construction and `bindMidx` move behind the existing `scan` memo, forced only by
`lookup` / `all` / `health` / `indexFaults` / `midxHealth` / `midxBitmap`. This part
does **not** touch `ctx.fs.exists(packsDir)` — that is Part 2's job.

**The pinned fact that justifies the shape** (design §2 Pin A, `git 2.55.0`): a
structurally self-inconsistent multi-pack-index makes canonical git die at exit 128
on a **loose** read too. So the gate must stay ahead of `tryLoose`, but the gate is
*exactly* the midx load and nothing else. Everything else about the pack store is
invisible to a successful loose read's outcome.

**Files to change (exact paths + symbol name-paths).**

`src/application/primitives/pack-registry.ts` (774 lines):

- `createPackRegistry(ctx)` — line 472. Today it builds one memo:
  `const scan = createPromiseMemo(scanPacks)` (line 532).
- `scanPacks` — lines 473-531. Current body, in order:
  `packsDir(commonGitDir(ctx))` → `if (!(await ctx.fs.exists(dir))) return emptyGeneration()`
  → `const [midxLoad, entries] = await Promise.all([loadMidxSet(ctx, dir), ctx.fs.readdir(dir)])`
  (line 485) → **the `midxLoad.faults` warn loop, lines 486-491** → `fileNames` Set
  → candidate loop calling `loadCandidatePack` → `bindMidx` → `midxBitmapMemo` →
  returns `{ packs, midxLoad, midx, indexed, warnedIdx, fileNames, midxBitmap }`.
- `currentGeneration()` — lines 562-565. The terminal-disposal rule the new gate must
  mirror: `if (!disposed) return scan.get(); return scan.peek() ?? Promise.resolve(emptyGeneration())`.
- `refresh()` — lines 715-733. Current order: `if (disposed) return;` →
  `healthMemo.clear()` → `midxHealthMemo.clear()` → `const outgoing = scan.clear()` →
  **`if (outgoing === undefined) return;`** → `trackClose(...)`.
- `dispose()` — lines 751-772. Peeks `scan` only; **leave it structurally alone**.
- `assertLoadable()` — lines 707-709 (`await currentGeneration()`), interface doc at
  lines 197-206.
- The comment block at lines 476-484 (the "SEPARATE step … Parallel with the listing"
  rationale) describes the old shape and must be rewritten for the new one.

`src/application/primitives/internal/pack-generation.ts` (133 lines):

- `EMPTY_MIDX_LOAD` — line 50, currently module-local. **Export it** (still internal:
  nothing under `internal/` is in `reports/api.json`) so the registry's post-dispose
  gate arm can resolve to it.
- `PackGeneration.midxLoad` doc — lines 62-66. It currently claims the field is
  "produced by the SAME `scanPacks` call as `packs`". After the split it is captured
  from the store gate the scan awaited; reword it to say that, and keep the invariant
  it is protecting ("no consumer can ever pair one generation's midx with another's
  packs"). **The field itself must stay** — its reader is `computeMidxHealth` in
  `src/application/primitives/internal/midx-binding.ts:317-335`, which projects
  `midxLoad.faults` and `midxLoad.flatFilePresent` into the `fsck` midx verdict, and
  it must keep seeing one consistent verdict per generation.

`src/application/primitives/internal/midx-source.ts` — `loadMidxSet(ctx, packsDir)`
returns `Promise<MidxLoadResult>` (`{ set, faults, flatFilePresent }`). **Unchanged**
(DC-3 keeps `probeFlat` then chain strictly sequential).

**Target shape** (implement in `createPackRegistry`, above `scan`):

Declare the gate factory and its memo **above `scanPacks`** (neither references
`disposed`):

```ts
// git dies during object-store setup ahead of every read, and the ONLY thing it
// dies on is a structurally self-inconsistent multi-pack-index — the directory
// listing and pack construction are invisible to a successful loose read. So the
// gate is exactly the midx load, and its Tier-B discard diagnostic belongs here
// too: git prints that one on a loose read.
const loadStoreGate = async (): Promise<MidxLoadResult> => {
  const midxLoad = await loadMidxSet(ctx, packsDir(commonGitDir(ctx)));
  for (const fault of midxLoad.faults) {
    ctx.logger?.warn?.('packRegistry: discarding unusable multi-pack-index', {
      artefact: fault.artefact,
      ...faultContext(fault.data),
    });
  }
  return midxLoad;
};
const storeGate = createPromiseMemo(loadStoreGate);
```

Declare the disposal-aware wrapper **beside `currentGeneration()` (line 562), after
`let disposed = false;` (line 534)** — placing it above `scanPacks` would reference
`disposed` before its `let`, which biome's use-before-declaration rule flags:

```ts
const currentGate = (): Promise<MidxLoadResult> =>
  disposed ? (storeGate.peek() ?? Promise.resolve(EMPTY_MIDX_LOAD)) : storeGate.get();
```

Then: `assertLoadable()` becomes `await currentGate();` and **keeps returning
`void`** — it must never become a second way to reach the packs. `scanPacks` calls
`storeGate.get()` **directly** (not `currentGate()`) and captures it **synchronously
at its top, before any `await`**, keeping the existing concurrency:
`const [midxLoad, entries] = await Promise.all([storeGate.get(), ctx.fs.readdir(dir)])`.
Two reasons this is correct and not a disposal hole: `scanPacks` is reachable only
through `currentGeneration()`, which already refuses to start a scan once `disposed`;
and capturing before the first `await` is exactly what gives "a scan in flight keeps
its own captured `MidxLoadResult`" for free. The warn loop is **deleted** from
`scanPacks` (it now lives in the gate). `refresh()` adds `storeGate.clear()`
immediately after `midxHealthMemo.clear()` — **before** the
`if (outgoing === undefined) return;` early return, or a Context that never scanned
would keep a stale gate forever.

**Invariants this part must preserve** (design §3.3): Tier-A propagates out of the
gate unchanged so `assertLoadable` still rejects before the empty-tree short-circuit,
the `deltaCache` probe and `tryLoose` — **`resolveObjectBytes`'s body order at
`src/application/primitives/object-resolver.ts:57-85` does NOT move**; Tier-B is a
recorded discard whose warn still fires on a loose hit; `refresh()` clears both memos
in one synchronous step; `dispose()` still peeks the scan memo only (the gate holds
no `FileHandle`s); `withLazyFetchRetry` in `src/application/primitives/read-object.ts:111-132`
is untouched; `adoptPackRegistry` (line 38) aliases the whole facade so both memos are
shared by construction; `openBlobSource` at
`src/application/primitives/internal/blob-source.ts:86` inherits the split with **no
edit** (it calls the same `assertLoadable()`).

**A deliberate, sanctioned micro-regression to note in the commit, not to "fix":** a
repository with NO `objects/pack` directory now pays two ENOENT stats through the gate
where it previously paid one `exists`. `probeFlat` maps `FILE_NOT_FOUND` to
`{kind:'absent'}`, so it resolves cleanly — and canonical git serves that repo too
(design §2 row E6).

**Memo semantics you can rely on** (`internal/promise-memo.ts`): `get()` memoises the
in-flight promise; a **rejection clears the slot**, so a Tier-A gate rejection is
re-attempted by the very next caller. This is what keeps
`pack-registry.test.ts:3830-3854` ("3 lookups → 3 midx reads") green.

**Tests to extend — existing ledgers, do NOT invent a second one.**

`test/unit/application/primitives/object-resolver.test.ts` (1934 lines):

- Helpers already present: `buildSeededContext` / `instrumentedContext` imported from
  `./fixtures.js` (line 21); `writeSyntheticPack` from `./pack-fixture.js`;
  `stubRegistry` (line 87) whose `assertLoadable: async () => {}` stub is at line
  125, with sibling stubs at 1225 / 1294 / 1368 / 1438.
- `instrumentedContext(base)` returns `{ ctx, calls }` where `calls()` yields
  `ReadonlyArray<{ method: string; path: string }>` covering `read`, `readSlice`,
  `readUtf8`, `exists`, `stat`, `lstat`, `readdir`, `openWithNoFollow`, … — this is
  the ledger to filter.
- **BREAKING ASSERTION you must update in this part:** the test at line 786-826
  (`describe('loose-oid probe (A2/B7b — per-fanout-dir cache)')` →
  `it('Then each touched fanout dir is readdir-ed at most once and exists is called only for the pack-registry presence probe')`)
  asserts `expect(existsSpy.mock.calls.length).toBe(1)` at **line 823**, with a
  comment at 816-820 explaining that the single `exists` is `assertLoadable`'s pack
  presence probe. Every read in it is a loose HIT, so after this part the scan never
  runs and the count is **0**. Change the expectation to `0`, retitle the `it` (drop
  "and exists is called only for the pack-registry presence probe" → "and the pack
  store is never probed"), and rewrite the comment to state the new reason.

`test/unit/application/primitives/pack-registry.test.ts` (5806 lines):

- **REWORD, DO NOT DELETE**, the test at line 3902-3934: describe
  `'Given two healthy packs and a healthy multi-pack-index'` → `'When a loose object
  is read'` → it `'Then assertLoadable does not force any .idx load: the ledger shows
  the readdir, one midx read, and zero .idx reads'`. After the split the ledger shows
  **one midx read and NO `objects/pack` readdir**. Keep the `idxReads` assertion
  (`toEqual([])`) and the `midxReads` `toHaveLength(1)`; replace
  `expect(readdirCalls.length).toBeGreaterThanOrEqual(1)` (line 3931) with an
  assertion that **no** `readdir` call targets a path ending `/objects/pack`. Retitle
  to name what it now proves.
- Local helpers available in that file: `buildSeededContext`, `instrumentedContext`,
  `writeSyntheticPack`, `writeMidxBytes`, `buildMidx`, `healthyMidxSpec`,
  `flipMidxSignature`, `expectMidxSignatureRejection`, `withHandleLedger`,
  `dirEntry`, `makeStat`.

`test/unit/application/primitives/stream-blob.test.ts` — home of the `openBlobSource`
surface; add the twin loose-hit ledger there so the two gates cannot drift.

`test/unit/application/primitives/read-object.test.ts` — home of the promisor /
lazy-fetch tests; the `withLazyFetchRetry` regression assertion belongs there.

**Coverage of the three read surfaces.** `readObject` and `readRawObject` both funnel
through `resolveObjectBytes` (`read-object.ts:141` and `:153`), so **one** ledger
covers both — do not write the same test twice. `openBlobSource` is a genuinely
**separate** `assertLoadable()` call site (`blob-source.ts:86`), which is exactly why
it gets its own ledger: the two gates must not drift.

**Guard-clause rule (mutation-resistance).** Each new branch needs its OWN isolated
test — one test tripping two conditions proves neither. In particular
"`refresh()` clears the gate when the scan memo was never populated"
(`outgoing === undefined`) must be a separate test from "`refresh()` clears both when
a scan did run", because they exercise different sides of that early return.

**Stryker mutates all of `src`**, including this seam even though coverage does not
gate it. The new `currentGate` ternary and its `?? Promise.resolve(EMPTY_MIDX_LOAD)`
arm each spawn mutants that only the two disposal tests (steps 8 and 9) kill, and only
if they assert an *observable* consequence (a call ledger, a resolved value) rather
than merely running the line. Write them that way from the start; a survivor found in
the mutation phase is a whole extra round-trip.

### TDD steps

1. **RED** — `object-resolver.test.ts`, new describe
   `'Given a cold Context whose requested object is loose'` → `'When resolveObject reads it'` →
   `'Then no readdir targets objects/pack and no .idx path is ever statted or read'`.
   Build via `buildSeededContext({ objects: [blob] })`, write two synthetic packs plus
   a healthy midx (mirror `pack-registry.test.ts:3906-3913`), wrap with
   `instrumentedContext`, resolve the loose id, then filter `calls()` for
   `method === 'readdir' && path.endsWith('/objects/pack')` (expect `[]`),
   `method === 'exists'` (expect `[]`), and any `path.endsWith('.idx')` (expect `[]`).
   Fails today: the eager scan lists `objects/pack` and calls `exists`.
2. **NET** (green today, must stay green — write it before GREEN so the deferral
   cannot silently become a skip) — same file,
   `'Given a cold Context whose requested object is NOT loose but IS packed'` →
   `'Then objects/pack is listed exactly once and the object still resolves'`.
3. **NET** (green today, must stay green — this is the ordering pin the whole design
   rests on) — same file,
   `'Given a Tier-A multi-pack-index (flipped signature) and a loose object that exists'` →
   `'Then the read throws INVALID_MULTI_PACK_INDEX with check signature before any fanout readdir runs'`.
   Assert the error's `.data.code` **and** `.data.check` (never `toThrow(Class)`
   alone), and assert zero `readdir` calls against `objects/<xx>`.
4. **RED** — same file, `'Given a Tier-B multi-pack-index (truncated) and a loose object that exists'` →
   `'Then the blob resolves, the discard warn fires once, and objects/pack is never listed'`.
   Inject `logger: { warn: vi.fn() }` onto the context. Fails today on the
   "never listed" half only — which is exactly the point.
5. **RED** — `stream-blob.test.ts`, `'Given a cold Context and a loose blob'` →
   `'When openBlobSource opens it'` → `'Then the ledger matches readObject: no objects/pack listing, no .idx touch'`.
   Fails today.
6. **RED** — `pack-registry.test.ts`, `'Given a registry whose gate has resolved but whose scan never ran'` →
   `'When refresh() is called and a read follows'` → `'Then the multi-pack-index is probed again'`.
   Drive it through `assertLoadable()` (which populates only the gate), then
   `refresh()`, then `assertLoadable()` again; count `stat`/`read` calls on the
   `multi-pack-index` path via `instrumentedContext`. Fails today (there is no gate to
   clear) and, after GREEN, fails again if `storeGate.clear()` is placed after the
   `outgoing === undefined` early return.
7. **RED** — `pack-registry.test.ts`, `'Given a registry with a populated scan'` →
   `'When refresh() is called'` → `'Then both the multi-pack-index and the pack directory are re-read on the next lookup'`.
   The paired-generation invariant; separate test from step 6 per the guard-clause rule.
8. **RED** — `pack-registry.test.ts`, `'Given a Context that only ever hit loose objects'` →
   `'When dispose() is called'` → `'Then objects/pack is never listed'`.
   Strengthens the existing "disposes without scanning" property.
9. **RED** — `pack-registry.test.ts`, `'Given a disposed registry'` →
   `'When assertLoadable() is called again'` → `'Then it resolves without starting a new multi-pack-index load'`.
   Pins the terminal-disposal rule for the gate (mirror of `currentGeneration()`'s).
10. **RED** — update `object-resolver.test.ts:786-826` (`existsSpy` → `0`, retitle,
    rewrite comment) and `pack-registry.test.ts:3902-3934` (reword title/`@proves`
    intent, assert no `objects/pack` readdir). Both now fail — correctly.
11. **GREEN** — implement the split exactly as the target shape above: export
    `EMPTY_MIDX_LOAD` from `internal/pack-generation.ts`; add `loadStoreGate` /
    `storeGate` / `currentGate` to `createPackRegistry`; move the warn loop into the
    gate; make `assertLoadable()` `await currentGate()`; have `scanPacks` capture
    `currentGate()` synchronously and keep the `Promise.all` with `ctx.fs.readdir`;
    add `storeGate.clear()` to `refresh()` before the early return. `dispose()`,
    `object-resolver.ts` and `blob-source.ts` are NOT edited.
12. **REFACTOR** — rewrite the three load-bearing comments: `assertLoadable`'s
    interface doc (lines 197-206) gains the pinned fact that the gate *is* the midx
    load because that is exactly what git dies on; the stale block at
    `pack-registry.ts:476-484` is replaced with the gate/scan seam rationale
    (including *why* the midx warn sits on the gate side and the orphan warn on the
    deferred side); `PackGeneration.midxLoad`'s doc is reworded. **No provenance refs
    (ADR/phase/backlog numbers) in any source or test file.** Re-run the full gate.

### Gate

Run each command bare, check `$?`, only then commit:

```
npx vitest run --project unit test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/stream-blob.test.ts test/unit/application/primitives/read-object.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/pack-registry.ts src/application/primitives/internal/pack-generation.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/stream-blob.test.ts test/unit/application/primitives/read-object.test.ts
```

### Commit

`perf(pack-registry): gate object reads on the multi-pack-index load alone`

---

## Part 2 — Serve a loose read when the pack directory cannot be listed

### Context

**Goal.** Delete `ctx.fs.exists(packsDir)` from `scanPacks`, fold the scan's own
`readdir` faults, and pin the whole matrix against real `git` in a new cross-tool
interop suite. This is the part where the **C4/E5 divergence closes**, and the interop
row that proves it **fails on `main` and passes here** — it is the single most
important assertion in this change.

**Src change — small and exact.** In `src/application/primitives/pack-registry.ts`,
inside `scanPacks` (post-Part-1 shape):

- Delete `if (!(await ctx.fs.exists(dir))) return emptyGeneration();`. Its only job
  was short-circuiting a missing directory, and `probeFlat` already maps
  `FILE_NOT_FOUND` to `{kind:'absent'}`, so the gate resolves cleanly for a repo with
  no `objects/pack` (canonical git agrees — design §2 row E6).
- Wrap the scan's `ctx.fs.readdir(dir)` so it folds absence to an empty listing and
  **propagates everything else**:

  | `readdir(objects/pack)` outcome | Scan behaviour |
  |---|---|
  | `FILE_NOT_FOUND` / `NOT_A_DIRECTORY` | empty listing → the `emptyGeneration()`-equivalent the removed `exists` guard produced |
  | anything else (`PERMISSION_DENIED`, …) | **propagate** — the fault is real, and it now reaches only the consumers that actually need the pack store |

  Both codes are needed: Node's `readdir` on a missing directory maps to
  `FILE_NOT_FOUND`, while `MemoryFileSystem.readdir`
  (`src/adapters/memory/memory-file-system.ts:184-190`) throws `NOT_A_DIRECTORY` for
  a missing directory. **Prior art to mirror, do not re-invent:**
  `src/application/primitives/internal/loose-oid-cache.ts:27-32`'s
  `isMissingFanoutDir` and `src/application/primitives/internal/shallow-set.ts`'s
  `isAbsentShallowFile` — both are `error instanceof TsgitError && (code === 'FILE_NOT_FOUND' || code === 'NOT_A_DIRECTORY')`.
  Keep the fold inside the `Promise.all` arm (`ctx.fs.readdir(dir).catch(...)`) so the
  gate/listing concurrency Part 1 preserved is not serialised.

**Why the gate itself needs no new tolerance code.** On a `chmod 000 objects/pack`,
the gate's `stat(objects/pack/multi-pack-index)` returns `PERMISSION_DENIED`, which
`isTierBMidxFault` (`internal/midx-source.ts:107-113`) already classifies as Tier B —
so the gate records a discard (and emits its warn), resolves, and the loose read
proceeds. The existing classifier covers it; add nothing.

**Expected fallout in `pack-registry.test.ts`.** Several tests stub
`exists: async () => true` or `exists: async (path) => path.endsWith('/objects/pack') ? true : ctx.fs.exists(path)`
(lines 152, 202, 251-252, 297, 320, 350-351, 870, 1366). Those stubs become dead once
`exists` is gone — they are harmless and biome will not flag them; removing them is
optional cleanup, but if you remove any, re-run the whole file. Tests that previously
relied on `exists` short-circuiting a missing `objects/pack` now take the readdir
fold instead and reach the same empty generation.

**New file: `test/integration/loose-read-store-gate-interop.test.ts`.**

Shape it on `test/integration/loose-corrupt-precedence-interop.test.ts` (116 lines) —
`@proves` header block, `describe.skipIf(!GIT_AVAILABLE)`, helpers from
`./interop-helpers.js`. Diverge from it in one way the design mandates: **ONE shared
`beforeAll` that builds the base repo (all the git spawns), with an explicit
`60_000` timeout**, then each row **copies** that directory tree (`node:fs/promises`
`cp` with `{ recursive: true }`) and mutates its own copy. Per-test git-built repos
are the documented flake class here; a tree copy costs no git spawn. If `cp` turns out
to be awkward for a row (a mode a row needs is not preserved, say), fall back to the
established shape in `midx-interop.test.ts:212-233`: a suite-level `roots: string[]`
with an `afterAll` sweep, a `newRoot(slug)` helper, and a per-row
`buildBaseFixture(root, 'repo')` inside a `beforeAll` carrying the same `60_000`
timeout. That suite runs ~30 such rows in CI today.

**Reuse `test/integration/midx-fixture-helpers.ts` — it already does most of this.**
Exports you need:

- `buildBaseFixture(baseDir, slug): Promise<{ dir, packedOids: [string,string,string], looseOid }>`
  — 3 packs, 9 packed objects, a flat midx written by `git multi-pack-index write`,
  and **one unreferenced loose blob** (`git hash-object -w --stdin`), with `.rev`
  files removed. Exactly the design §2 fixture.
- `midxPaths(dir) → { flat, chainDir, chainFile }`.
- `mutateMidxOrThrow(filePath, op)` — chmods writable, applies `op`, **re-stamps the
  SHA-1 trailer**, writes back, and verifies the write landed. The one sanctioned way
  to corrupt a midx.
- `chunkTableRowOffset(bytes, id)` — the chunk-table row offset for a 4-ascii chunk
  id (`'OIDF'`, …), for clobbering a chunk's identity.
- `DIGEST_LENGTH` (= 20), `readChainDigests`, `chainLayerPath`, `removeRevFiles`.

`parseMultiPackIndex` (needed by the A3 recipe) comes from
`../../src/domain/storage/index.js`; `readObject` / `disposePackRegistry` from
`../../src/application/primitives/read-object.js`; `createNodeContext` from
`../../src/adapters/node/node-adapter.js`; `TsgitError` from
`../../src/domain/error.js` — the same import set `midx-interop.test.ts:18-47` uses.

From `./interop-helpers.js`: `GIT_AVAILABLE`, `runGitEnv()` (scrubs every `GIT_*`,
pins an isolated non-existent `HOME`, sets `GIT_CONFIG_NOSYSTEM=1`), `runGitAsync`,
`tryRunGitWithExit(args, {env}) → { stdout, stderr, exitCode }` (never throws — this
is what asserts git's exit 128 vs exit 0).

**`@proves` header — the values are gate-constrained, use these.**
`tooling/test-pyramid/detect-integration-proof.ts` fails `validate` when two
integration files claim the same `(surface, bucket)` pair, and
`loose-corrupt-precedence-interop.test.ts` already owns `readObject | cross-tool-interop`
while `midx-interop.test.ts` owns `pack.readMultiPackIndex | cross-tool-interop`.
`surface` must match `^[a-z][a-zA-Z0-9.-]{1,40}$`, `bucket` must come from the enum in
`test-pyramid-budgets.json`, `unique` must be 12-200 characters, and the
`cross-tool-interop` bucket's `directoryRules` require the file to sit at
`test/integration/` **root** (not a subdirectory).

```
 * @proves
 *   surface:        objectStore.storeGate
 *   bucket:         cross-tool-interop
 *   unique:         a loose read is denied only by a structurally self-inconsistent multi-pack-index, never by the pack directory
 *   interopSurface: objects/pack
```

**The rows to pin** (design §2; git side via `tryRunGitWithExit(['-C', dir, 'cat-file', '-p', looseOid], { env: runGitEnv() })`,
tsgit side via `readObject(ctx, looseOid)` from
`src/application/primitives/read-object.js` on a Context from
`createNodeContext({ workDir: dir })`):

| Row | Fault applied to the copy | git | tsgit |
|---|---|---|---|
| A1 | `mutateMidxOrThrow(flat, (bytes) => { bytes[3] = (bytes[3] ?? 0) ^ 0x01; return bytes; })` | exit 128 | `readObject` rejects with `{ code: 'INVALID_MULTI_PACK_INDEX', check: 'signature' }` |
| A3 | `mutateMidxOrThrow(flat, (bytes) => { const parsed = parseMultiPackIndex(bytes, DIGEST_LENGTH); bytes.writeUInt32BE(0xffff, parsed.oidFanoutOffset); return bytes; })` | exit 128 | rejects with `check: 'fanout'` — proves the gate is not signature-specific |
| A4 | truncate the flat midx to 40 bytes (Tier B) | exit 0 + content | serves the same blob bytes **and** emits `packRegistry: discarding unusable multi-pack-index` |
| E3 | remove the flat midx, create `multi-pack-index.d/multi-pack-index-chain` holding garbage | exit 0 + content | serves **and** warns the same |
| **C4/E5** | **`chmodSync(<dir>/.git/objects/pack, 0o000)`** | **exit 0 + content** | **returns the same blob bytes** — fails on `main`, passes here |
| C5 | remove the flat midx, then delete every `*.pack` leaving the `.idx` files (orphans) | exit 0, silent | serves **and emits NO logger warn** |
| E6 | `rm -rf <dir>/.git/objects/pack` | exit 0 | serves |

Those two byte recipes are lifted verbatim from `midx-interop.test.ts`'s
`TIER_A_ROWS` (rows G1 and G13, lines ~415-495) — **use them verbatim, do not
hand-roll a variant**, so the two suites cannot drift on the one byte recipe that has
to stay identical.

**Known, deliberate overlap — state it in the file header so review does not read it
as sloppiness.** `midx-interop.test.ts` already asserts both Tier-A refusals on its
own `fixture.looseOid` (`expectTierARow` walks `[...packedOids, looseOid]`), so rows
A1 and A3 here are **not** new coverage. They stay because this suite's whole
argument is "the deferral is safe *because* Tier-A still denies a loose read", and a
reader must be able to see that anchor without leaving the file. Keep them to exactly
one loose-oid assertion each, reuse the shared helpers, and point the header comment at
`midx-interop.test.ts` as the home of the exhaustive Tier-A matrix. Rows A4, E3,
C4/E5, C5 and E6 are the genuinely new coverage.

**Row-specific traps you must handle.**

- **Fresh Context after every git subprocess.** The per-fanout-dir loose-oid
  membership set (`internal/loose-oid-cache.ts`) is memoised per `Context` and is
  invalidated only by tsgit's own `writeObject`. Build the `Context` **after** the
  fixture's last `git` write and after the row's mutation, or the probe silently
  measures the wrong thing. `-C <path>` does **not** override an inherited `GIT_DIR`
  — always pass `runGitEnv()`.
- **C4/E5 must skip as superuser and must restore the mode.** Guard the row with
  `os.userInfo().uid === 0` (mode bits are ignored for root) and also
  `process.platform === 'win32'` (a `chmod 000` directory is still listable there);
  the `integration` vitest project runs on `ubuntu-latest` in CI, so the POSIX path is
  the live one. Restore with `chmodSync(packDir, 0o755)` in a `finally`, otherwise the
  suite's own `afterAll` `rm(..., { recursive: true })` cannot descend into it.
  Detect root via `os.userInfo().uid` (`node:os` is already in this suite's import
  set) rather than the `process`-level POSIX uid getter — that getter's identifier is
  absent from the project's cspell dictionary and would fail `check:spelling`, and so
  `validate`.
- **C4/E5 will emit the Tier-B discard warn** (the gate's `stat` on the midx returns
  `PERMISSION_DENIED` → Tier B). That is correct and matches git printing its own
  `error: unable to open object pack directory`. Assert bytes, not warn-absence, on
  this row.
- **C5 needs the midx removed first** — with the midx present it is design row E1 (a
  healthy midx naming a deleted pack), a different row. Observe warns by spreading a
  logger onto the Context: `createNodeContext` takes no logger option, so build
  `const ctx: Context = { ...createNodeContext({ workDir: dir }), logger: { warn } }`
  and call `disposePackRegistry` on that same object (the registry cache is a
  `WeakMap` keyed by Context identity).
- Track every Context and dispose it in `afterEach`, as `midx-interop.test.ts:142-149`
  does, or persistent pack handles leak across rows.

**Unit-level companions for the new branches** (guard-clause rule: one test per
condition), in `test/unit/application/primitives/`:

- `object-resolver.test.ts`: `'Given a Context whose readdir of objects/pack rejects with PERMISSION_DENIED'` →
  `'When resolveObject reads an object that is loose'` → `'Then it resolves with the blob'`.
- `pack-registry.test.ts`: `readdir` rejecting `FILE_NOT_FOUND` → `all()` returns `[]`.
- `pack-registry.test.ts`: `readdir` rejecting `NOT_A_DIRECTORY` → `all()` returns `[]`
  (**separate test** — one test tripping both proves neither).
- `pack-registry.test.ts`: `readdir` rejecting `PERMISSION_DENIED` → `all()`
  **rejects** with `PERMISSION_DENIED`, asserting `.data.code` explicitly.

Also revisit `object-resolver.test.ts:786-826` — after Part 1 it already expects
`0` `exists` calls; here that becomes true for a stronger reason, so refresh the
comment only.

**Test-pyramid budget note.** `test-pyramid-budgets.json` targets 15 % integration
files with a `warnAbove` of 25 %; one added file cannot flip the band. No budget edit
is needed — do not touch that file.

### TDD steps

1. **RED** — write `test/integration/loose-read-store-gate-interop.test.ts` with the
   `@proves` header above, the shared `beforeAll` base fixture (60 s timeout), the
   per-row tree copy, and all seven rows. A1/A3/A4/E3/C5/E6 pass immediately (they
   pin behaviour Part 1 already delivers, and locking them in now is the point);
   **C4/E5 fails** — `readdir(objects/pack)` rejects `PERMISSION_DENIED` and denies
   the loose read where git serves it.
2. **RED** — the four unit companions above. Construct each so it exercises the fold
   **directly**: a Context whose `objects/pack` genuinely exists, with `ctx.fs.readdir`
   stubbed to reject with the row's code. That makes all four genuinely red today (the
   surviving `exists` returns `true`, so today's `readdir` rejection propagates for
   every code), and it removes any ambiguity about whether a green came from the fold
   or from the presence probe that is about to disappear.
3. **GREEN** — delete `ctx.fs.exists(dir)` from `scanPacks`; add the
   `FILE_NOT_FOUND` / `NOT_A_DIRECTORY` → empty-listing fold on the scan's own
   `readdir`, propagating every other fault, inside the existing `Promise.all` arm.
4. **REFACTOR** — document at the fold **why** only those two codes are absent
   (mirroring `loose-oid-cache.ts`'s reasoning) and why a real fault now reaches only
   pack-store consumers. Optionally drop the newly-dead `exists` stubs in
   `pack-registry.test.ts`; if you do, re-run the whole file. Re-run the full gate.

### Gate

Run each command bare, check `$?`, only then commit:

```
npx vitest run --project unit test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/pack-registry.test.ts
npx vitest run --project integration test/integration/loose-read-store-gate-interop.test.ts
npm run check:types
./node_modules/.bin/biome check src/application/primitives/pack-registry.ts test/integration/loose-read-store-gate-interop.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/pack-registry.test.ts
```

Also run `npm run check:test-pyramid` bare in this part — it is the gate that would
reject a duplicate `(surface, bucket)` pair or a malformed `@proves` header, and it
only runs inside `validate` otherwise.

### Commit

`fix(pack-registry): serve a loose read when the pack directory cannot be listed`

---

## Part 3 — Hand pre-resolved containment roots from the node shim to the adapter

### Context

**Goal (DC-2, option (b)).** `openRepository` already realpaths `cwd` and canonicalises
`gitDir`/`commonDir`, then hands `layoutRootsOf(layout)` to a `NodeFileSystem` whose
`loadRootSet()` realpaths every root **again** on the first port call — 0.0163 ms for
a normal repo, ~0.034 ms for a linked worktree, paid by *every* first read (loose or
packed), which is why this is the only lever that moves the small-pack row. Make the
shim hand its already-resolved roots down as **data**. This is **not** Lever 5c: the
containment check still runs, on every path, against the same canonical prefixes.

**Files and current signatures.**

`src/index.node.ts` (159 lines):

- `openRepository(opts: OpenNodeRepositoryOptions = {})` — line 46. Line 55:
  `const resolvedCwd = await realpath(nodePath.resolve(cwd)).catch(() => nodePath.resolve(cwd));`
  Line 61: `const layout = await resolveNodeLayout(resolvedCwd);`
  Line 70: `const fs = new NodeFileSystem(layoutRootsOf(layout), nativePolicy);`
- `canonicalize` — line 129: `const canonicalize = (p: string): Promise<string> => realpath(p).catch(() => p);`
- `resolveNodeLayout(cwd: string): Promise<RepositoryLayoutInput>` — lines 143-153.
  Falls back to `{ workDir: cwd, gitDir: join(cwd, '.git'), bare: false }` when
  `findLayout` finds nothing.
- `makeWorktreeFs` — line 97-98:
  `new NodeFileSystem([layout.workDir, ...worktreePaths], nativePolicy)`.
  **`worktreePaths` are caller-supplied and NOT canonical — this call site must keep
  today's behaviour and pass no pre-resolved roots.**

`src/adapters/node/node-file-system.ts` (1020 lines):

- `constructor(rootDir: string | ReadonlyArray<string>, pathPolicy: PathPolicy = nativePolicy, fsOps: FsOperations = realFsOps)` — lines 448-465.
  Refuses an empty root set with `unsupportedOperation('constructor', 'NodeFileSystem requires at least one root')`.
- `private async canonicalizeRoots(): Promise<ReadonlyArray<RootPrefix>>` — lines
  490-515. Realpaths every root; ENOENT falls back to `realpathNearestExisting`, then
  to the lexical root; every other errno rejects.
- `private async loadRootSet(): Promise<RootSet>` — lines 525-543. Memoises
  `{ canonical, all: unionRootPrefixes(this.getRootDirPrefixes(), canonical) }` into
  `rootSetPromise` + `resolvedRootSet`, clearing both on rejection.
- `private toRootPrefix(root)` — line 476.

`src/repository/layout-roots.ts` — `layoutRootsOf(layout)` dedupes
`[workDir, gitDir, commonDir ?? gitDir]` and drops any root contained in another: a
normal repo collapses to `[workDir]`, a linked worktree to `[workDir, commonDir]`.

`src/adapters/node/node-adapter.ts:54` — `createNodeContext` builds
`new NodeFileSystem(workDir)` with a plain `nodePath.resolve`d path. **Must keep
today's canonicalisation** — every interop test (including Part 2's) runs through it.

**THE CORRECTNESS TRAP — read this twice.** The shim's roots are canonical **only
when its realpaths actually succeeded**. Both `realpath(...).catch(() => resolve(cwd))`
(line 55) and `canonicalize = realpath(p).catch(() => p)` (line 129) fall back to the
**un-canonical** path when the target does not exist — the routine `init` / `clone`
case, where `openRepository` legitimately points at a not-yet-existing directory. And
the `findLayout`-found-nothing branch synthesises a `gitDir` that was never realpathed
at all. If those un-canonical roots are handed down as "pre-resolved", the adapter
loses `canonicalizeRoots`'s `realpathNearestExisting` fallback — the very thing that
makes `worktree add` under a symlinked `/tmp` (macOS `/tmp` → `/private/tmp`,
`/var` → `/private/var`) work. Failure would be closed (`PERMISSION_DENIED`), not
open, but it would still be a regression.

**So the hand-off is conditional, and the condition is an observed outcome, not an
assertion:** the shim passes pre-resolved roots **only when every `realpath` it
performed returned successfully**. Thread that outcome through instead of discarding
it — e.g. have `canonicalize` return `{ path, canonical: boolean }` and have
`resolveNodeLayout` return the layout paired with the AND of every outcome (`false`
for the not-found fallback branch, conservatively). Then:

```ts
const roots = layoutRootsOf(layout);
// `undefined` for fsOps takes the constructor's own `realFsOps` default — the shim
// never imports it, and must not start now.
const fs = new NodeFileSystem(roots, nativePolicy, undefined, canonical ? roots : undefined);
```

**Adapter shape** (minimal diff; touches no existing call site):

- Add a 4th optional constructor parameter, `resolvedRoots?: ReadonlyArray<string>`,
  documented as "each entry is the already-realpathed form of the correspondingly
  indexed entry of `rootDir`; supplying it means the adapter has nothing left to
  resolve". **Fail closed on a length mismatch** with the same
  `unsupportedOperation('constructor', …)` shape the empty-root guard already uses —
  a wrong-length hand-off must never silently degrade.
- `canonicalizeRoots()` returns `resolvedRoots.map((root) => this.toRootPrefix(root))`
  when the field is present, and today's realpath work otherwise. Everything
  downstream (`loadRootSet`, `unionRootPrefixes`, both containment gates) is
  **unchanged** — with pre-resolved roots equal to the raw roots the union dedupes to
  one prefix set, exactly what a successful identity realpath produces today.
- Do **not** add any option to `OpenRepositoryOptions` / `OpenNodeRepositoryOptions`.
  DC-2 forbids a library consumer ever asserting this.

**SURFACE GATES THIS PART MUST PRE-PAY** (the only part in this plan that has any):

1. `NodeFileSystem` is exported from the `@scolladon/tsgit/adapters/node` entry and
   its constructor's parameter list is recorded in `reports/api.json`. After the
   change, run `npm run docs:json` and **commit the regenerated `reports/api.json`**.
   Verify with a bare `git diff --exit-code -- reports/api.json` — that command is
   literally what the `check:doc-typedoc` prepush gate runs. Skipping this leaves
   `validate` green and the push hook red.
2. **100 % coverage applies here.** `src/adapters/node/**` is inside
   `vitest.config.ts`'s coverage `include` with 100 % thresholds on statements,
   branches, functions and lines. Every arm of the new branch — parameter supplied,
   parameter omitted, length-mismatch refusal — needs its own test.
3. No new error code and no new union member: reuse `unsupportedOperation`. So
   `src/domain/error.ts`, the exhaustiveness switches and the barrel-surface test are
   **not** touched.
4. `src/index.node.ts` is not in the coverage `include` list, so the shim side owes no
   threshold work — but it is type-checked and biome-linted.

**Tests.**

- `test/unit/adapters/node/node-file-system-injected.test.ts` (134 KB) is the home:
  it already builds fake `FsOperations` via a local
  `fakeFsOps(overrides: Partial<FsOperations>)` helper (line ~40) and constructs
  `new NodeFileSystem(rootDir, posixPolicy, fsOps)` throughout, with
  `vi.fn()`-instrumented `realpath` spies (see lines 76-100, 218-246 for the counting
  patterns to copy).
  - `'Given a NodeFileSystem constructed with pre-resolved roots'` → `'When the first path-taking call resolves the root set'` → `'Then fsOps.realpath is never called'`.
  - `'Given a NodeFileSystem constructed WITHOUT pre-resolved roots'` → same When →
    `'Then fsOps.realpath is called exactly once per root'` (the regression net that
    keeps `createNodeContext` / `makeWorktreeFs` honest).
  - `'Given pre-resolved roots whose length does not match the raw roots'` →
    `'When the adapter is constructed'` → `'Then it refuses with UNSUPPORTED_OPERATION'`,
    asserting `.data.code` **and** `.data.operation` (never `toThrow(Class)` alone).
- Symlinked-root regression — the macOS `/var` → `/private/var` class the design calls
  out. Put it in `test/integration/node-shim.test.ts` (already exercises the real
  `openRepository` shim on real paths): create a real repo in an `mkdtemp` directory,
  `symlinkSync` a sibling path to it, `openRepository({ cwd: <symlink path> })`, and
  assert a read through the returned handle succeeds. This is the test that catches a
  hand-off that skipped a realpath it should have performed.
- Whole-repo net: `openRepository` + first read must perform exactly one `realpath`
  per **distinct** root. Assert the halves separately — the adapter's zero via the
  injected `fsOps` ledger above, and the shim's own unchanged count via the symlink
  regression staying green. Do not try to spy on `node:fs/promises` from the shim; the
  two-sided assertion is the honest, mutation-resistant framing.

**Do NOT** touch `docs/perf/hot-paths.json` (DC-7) or attempt any `openRepository`
laziness (DC-6).

### TDD steps

1. **RED** — `node-file-system-injected.test.ts`: pre-resolved roots ⇒ zero
   `fsOps.realpath` calls on first use. Fails (the parameter does not exist yet — it
   fails to type-check, which is a legitimate RED for a new signature).
2. **NET** (green today, must stay green — this is what keeps `createNodeContext` and
   `makeWorktreeFs` honest once the parameter exists) — same file: omitted parameter ⇒
   exactly one `realpath` per root.
3. **RED** — same file: mismatched length ⇒ `UNSUPPORTED_OPERATION` with
   `operation: 'constructor'`, asserted on `.data`.
4. **NET** (green today, must stay green — the single most important regression net in
   this part) — `test/integration/node-shim.test.ts`: `openRepository` through a
   symlink to a real repo still reads.
5. **GREEN** — add the 4th constructor parameter + the length-mismatch refusal; make
   `canonicalizeRoots()` return the pre-resolved prefixes when supplied.
6. **GREEN** — thread the realpath outcomes through `src/index.node.ts`
   (`canonicalize` returning its own success flag, `resolveNodeLayout` returning the
   layout paired with the conjunction, `false` for the not-found fallback) and pass
   `layoutRootsOf(layout)` as `resolvedRoots` **only** when every realpath succeeded.
   Leave `makeWorktreeFs` (line 97-98) and `createNodeContext`
   (`node-adapter.ts:54`) passing no pre-resolved roots.
7. **REFACTOR** — document on the constructor parameter that this is a data hand-off,
   that a mismatch fails closed, and that the containment check itself is unchanged.
   **No ADR/phase refs in code.**
8. **Pre-pay the surface gate**: `npm run docs:json`, then stage the regenerated
   `reports/api.json` with the commit. Confirm with a bare
   `git diff --exit-code -- reports/api.json`.
9. **REFACTOR** — run `npm run test:coverage` bare and confirm 100 % over
   `src/adapters/node/node-file-system.ts`; add the missing arm's test if not.

### Gate

Run each command bare, check `$?`, only then commit:

```
npx vitest run --project unit test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system.test.ts test/unit/adapters/node/node-adapter.test.ts
npx vitest run --project integration test/integration/node-shim.test.ts test/integration/linked-worktree-discovery-interop.test.ts
npm run check:types
npm run test:coverage
npm run docs:json && git diff --exit-code -- reports/api.json
./node_modules/.bin/biome check src/index.node.ts src/adapters/node/node-file-system.ts test/unit/adapters/node/node-file-system-injected.test.ts test/integration/node-shim.test.ts
```

### Commit

`perf(node): hand pre-resolved containment roots to the filesystem adapter`

---

## Part 4 — Companion loose-read bench scenario and the main-vs-branch measurement

### Context

Test-infra-only, no `src/` delta — legitimately standalone per the sizing rules. It
delivers DC-4's measurement half and requirement 11 (absolute wall-clock deltas).

**Why the companion exists.** `test/bench/loose-read.bench.ts`'s existing scenario
compares tsgit's `openRepository` + `readBlob` + `dispose` against isomorphic-git's
stateless `git.readBlob({fs, dir, oid})`. Those are different units of work: ~33 % of
the tsgit side is handle lifecycle the peer never performs (0.133 ms open + 0.012 ms
dispose out of a 0.443 ms scenario). **The existing scenario stays exactly as it is**
— first-touch cost is real and is what this change attacks. The companion measures the
shape real consumers use: open once, read N times (~0.061-0.086 ms on the design's
machine, against a peer one-shot the design directionally puts at ~0.111 ms).

**Current file** (`test/bench/loose-read.bench.ts`, 44 lines): top-level
`const fixture = await setupSmallRepo({ commits: 50 })` and
`const blobId = fixture.firstBlobId as ObjectId`, then one `benchScenario(given,
whenThen, build)` whose `build` registers `afterAll(async () => { await fixture.cleanup(); })`
**inside the describe body** and returns `{ sut, baseline }`.

**THE TRAP — fix it before adding anything.** `benchScenario`
(`test/bench/support/bench-dsl.ts:36-52`) wraps the build in `describe(...)`. An
`afterAll` registered inside the first describe fires when **that describe** finishes
— i.e. it would `rm` the fixture directory before a second describe's benches ever
run. **Hoist `afterAll(async () => { await fixture.cleanup(); })` to the file's top
level**, outside both `benchScenario` calls, so it runs once after every scenario.
`afterAll` is already imported at line 11.

**Contract that binds the shape** (`bench-dsl.ts:1-12`): the two `bench()` names must
stay **exactly** `tsgit` / `isomorphic-git` — `tooling/bench-summarize.ts:58-59` finds
them by literal name, `tooling/bench-check.ts` (the `benchmark-compare` job) and
`tooling/bench-to-snapshot.ts` key on them. Only the `describe` title varies. So the
companion is a **new `benchScenario(...)` call in the same file**, never a third
`bench()` inside the existing one. Snapshot keys are
`` `${group.fullName} > ${bench.name}` `` (`bench-to-snapshot.ts:49`), so a second
describe in the same file produces distinct keys and one extra summary row — no
collision, no converter change.

**Companion shape.** Open the repository once in the `build` (like
`test/bench/midx-lookup.bench.ts:28-41`'s `readBlobBench`, which registers
`afterAll(async () => { await repo.dispose(); })` inside its own describe — that
pattern is correct here because the handle belongs to this describe), then:

```ts
sut: async (): Promise<void> => { await repo.primitives.readBlob(blobId); },
baseline: async (): Promise<void> => {
  await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId });
},
```

Title it in the repo's Given/When-Then form, e.g.
`'Given a repository handle opened once and reused across calls'` /
`'When readBlob() reads a blob on the open handle, Then compare tsgit against isomorphic-git'`.

**Why this is not just the warm-cache row.** Loose reads never populate
`ctx.deltaCache` — `cacheEntry` is called only from `resolvePackChain` and
`resolveBaseForRefDelta` in `src/application/primitives/object-resolver.ts`, both on
the packed path. The fixture's `firstBlobId` is loose (design §1.2's syscall trace
ends in `readdir(objects/c2)` + `readFile(objects/c2/…)`), so every measured call is a
genuine membership-cached loose read, not an LRU hit.

**Do NOT** add `loose-read` to `docs/perf/hot-paths.json` (DC-7 (b), ratified). The
fresh-repo row stays ungated by `benchmark-compare` and is read off the nightly by
hand.

**The measurement obligation (requirement 11).** Report **absolute wall-clock,
same machine, `main` vs this branch**. Never a self-share percentage — that framing
has misled this project before. The sharpest local signal is
`test/bench/midx-lookup.bench.ts`'s existing row
`'When readBlob() resolves a loose object with no packs (the assertLoadable gate,
isolated), Then measure tsgit'` (line 78-82), which prices the gate in isolation
against `LOOSE_ONLY_FIXTURE` from `test/bench/support/fixture-generator.ts`; its
cold-open siblings at lines 118-122 and 142-146 price the same gate through
`openRepository` and `streamBlob`.

**Split of duties, because a part agent must never change repo-wide git state.**
Measure the **branch** side here, in this worktree, and record the absolute medians in
the part's return message. Do **not** create a git worktree, check out another branch,
or touch the index/stash to get a `main` baseline. The `main` numbers come from the
main checkout (a normal repo already sitting on `main`) and are the session's to take;
surface that explicitly as a handoff item alongside your branch numbers so the pairing
happens outside this part. These numbers are **directional only and must never be
published** — the citable source is the CI nightly `bench.yml` artifact.

### TDD steps

Benchmarks have no red/green oracle; the RED analogue is "the scenario must actually
execute and appear in the raw report", so drive it that way.

1. **RED** — hoist `afterAll(fixture.cleanup)` to the file's top level and add the
   companion `benchScenario` call. Run
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/loose-read.bench.ts`
   bare. Before the hoist the companion errors on a deleted fixture directory; after
   it, both scenarios must complete.
2. **GREEN** — confirm `reports/benchmarks/raw.json` carries **two** groups for this
   file, each with a `tsgit` and an `isomorphic-git` benchmark under those exact
   names, then run `npm run bench:summary` bare and confirm two rows render (the
   summary is uncommitted output — do not stage `reports/benchmarks/`).
3. **REFACTOR** — extend the file's header comment to say what each scenario measures
   and why both exist (first-touch cost vs. the reused-handle shape), without any
   ADR/phase reference.
4. **Measure** — run
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/midx-lookup.bench.ts`
   in **this worktree only** and record the absolute medians for the three loose-only
   rows (the isolated `assertLoadable` gate row at lines 78-82 plus the two cold-open
   rows at 118-122 and 142-146). Report them as branch absolute wall-clock and hand the
   `main` baseline off to the session per the split above. If the branch is not faster
   on the isolated gate row, **escalate** as `{ unit, reason, ≤3 options }` rather than
   re-tuning silently — the design projects roughly −0.041 ms from the seam plus
   −0.0163 ms from the root hand-off.

### Gate

Run each command bare, check `$?`, only then commit:

```
npx vitest bench --run --config vitest.bench.config.ts test/bench/loose-read.bench.ts
npm run check:types
./node_modules/.bin/biome check test/bench/loose-read.bench.ts
```

### Commit

`test(bench): add an open-once loose-read companion scenario`

---

## Part 5 — Refresh the performance and registry-internals documentation

### Context

Docs-only, no `src/` delta — legitimately standalone per the sizing rules. **Planned
last on purpose**, so a nightly dispatched on this branch has time to run: the numbers
below must come from the CI artifact, never from a local run.

**BLOCKER TO SURFACE, NOT TO INVENT.** Design §8 requires **every** row of the table
to be transcribed afresh **from one single dated nightly artifact** — mixing two runs
in one table is not citable. The brief supplies only 7 of the 13 rows (fresh repo
0.39×, small pack 0.74×, medium pack 25.51×, `delta-chain` cold 0.36×, `status:clean`
small 0.63× / medium 0.59×, `status:dirty` 3.49×, `log:walk` medium 18.56×). The
remaining **six** — `clone:small-repo`, `log:walk` (small), both `readBlob:warm-cache`
rows, and `delta-chain` (warm) — **are not in this plan and must not be guessed**.
Obtain them from the same CI nightly `bench.yml` artifact as the other seven, and if
that artifact is not available, **escalate as `{ unit, reason, ≤3 options }`** rather
than carrying a stale value forward from the current table. The design also notes the
fresh-repo/small-pack ratios themselves should ideally come from a nightly dispatched
on **this branch**.

**File 1 — `docs/understand/performance.md`** (114 lines as committed). Exact edits,
per design §8:

| Lines | Edit |
|---|---|
| 5-12 | **Delete** the "The table below predates the git-parity containment change" block quote entirely. |
| 18 | **Replace** the provenance line with the new nightly's: `linux-x64`, AMD EPYC 7763, Node 22.23.2 · isomorphic-git 1.41.3 · captured 2026-08-14 (`bench.yml` run 31818556244) — or whatever the artifact you actually read says. |
| 20-34 | **Transcribe every row afresh** from that one run (the 13-row table). |
| 49-55 | **Add** a methodology bullet stating the unit-of-work asymmetry: `readBlob:cold-cache` (fresh repo) compares a stateful `openRepository` + `readBlob` + `dispose` against isomorphic-git's stateless `git.readBlob({fs, dir, oid})`; the handle lifecycle is measured on the tsgit side only, while the companion scenario in `test/bench/loose-read.bench.ts` measures the reused-handle shape. **Name the file/scenario, never a plan part number** — the published page must not reference this plan. |
| 70-75 | **Rewrite** the "Why status:clean / readBlob:cold / delta-chain:cold trailed" section (see below). |
| 96 | **Update** the Phase 26.4 target line, whose "(currently 0.60× small pack / 20.48× medium pack)" parenthetical is now stale. |

Rewrite of the "Why … trailed" section (line 72 is one very long bullet):

- **Drop** the directional laptop A/B note inside line 72 ("~2× (medium) to ~2.5×
  (small) … the fresh-repo `readBlob:cold` at ~1.4×"). Real numbers now exist; the
  placeholder has done its job.
- **Restate the causal story** to match the new numbers: `status:clean` moved
  0.40× → 0.59× (medium) and 0.45× → 0.63× (small) — the containment collapse and
  walker changes landed, and what remains is per-entry stat work. `readBlob:cold`
  (fresh repo) moved 0.33× → 0.39×: the residual is **repository-open fixed cost plus
  first-object-access store setup**, not containment. Name the split from design §1.1:
  open ≈ 30 %, first read ≈ 48 %, and the steady-state read is already ahead of the
  peer.
- **Keep verbatim** the existing Lever-5c paragraph (line 75) — its trust-boundary
  language is exactly why 5c stays out of scope, and it is still accurate.
- **Keep** the gate-asymmetry sentence, updating the quoted ratios (0.33× → 0.39×,
  0.35× → 0.36×). `docs/perf/hot-paths.json` is **not** edited (DC-7).

**File 2 — `docs/use/primitives/internals.md`, line 29** (the pack-registry paragraph;
the design missed this one, it is a real staleness). Three claims go stale with the
seam:

- "Lazy, single-flight scan of `.git/objects/pack/` … **The same scan** also discovers
  `objects/pack/multi-pack-index`" — after the split the multi-pack-index load is its
  own memo, awaited by the read gate; the directory listing and pack construction sit
  behind a second memo that only `lookup`/`all`/`health`/`indexFaults`/`midxHealth`/
  `midxBitmap` force.
- Add the two behaviours that changed for a consumer: a pack directory whose listing
  is refused no longer denies a loose read, and the
  `packRegistry: skipping pack index with no pack file` warn no longer fires on a
  loose hit (it still fires on any read that reaches the pack store). The
  `discarding unusable multi-pack-index` warn **does** still fire on a loose hit.
- "`refresh()` retires and closes the outgoing pack set — and re-reads the midx" stays
  true; make it explicit that both memos clear together. "`dispose()` … is terminal"
  stays true; note that a Context that only ever hit loose objects now disposes
  without listing the pack directory at all.

Keep the paragraph's existing claim that "a structurally self-inconsistent midx or
chain layer denies every read through the `Context` — loose objects included" — that
is unchanged and is the pinned fact.

**Style constraints.** Prose only; British spellings as elsewhere in
`docs/understand/`. The `cspell` dictionary lags on some `-ising`/`-ised` forms, so run
`npm run check:spelling` bare rather than trusting the markdown commit hook. No
ADR/phase references inside source or test files (docs pages may and do link ADRs —
that is the established convention on these pages). Do not tick anything in
`docs/BACKLOG.md`; the docs phase owns that under its own guard.

### TDD steps

Prose has no test oracle; the RED analogue is the doc gates plus a claim-by-claim
audit against the artifact and the landed code.

1. **RED** — obtain the dated nightly artifact and read **all 13** ratios off it. If
   six of them cannot be sourced from the *same* run, stop and escalate as
   `{ unit, reason, ≤3 options }`. Do not proceed on mixed runs.
2. **GREEN** — apply the six `docs/understand/performance.md` edits from the table
   above, in file order, so the line references stay usable as you go.
3. **GREEN** — rewrite `docs/use/primitives/internals.md` line 29's pack-registry
   paragraph per the three points above. Verify each claim against the code as landed
   in Parts 1-2 (`createPackRegistry` in
   `src/application/primitives/pack-registry.ts`), not against this plan.
4. **REFACTOR** — re-read both pages end to end for internal contradictions: no
   surviving sentence may still say the containment tax explains the cold-read gap,
   claim a single scan discovers the midx, or quote a ratio the new table does not
   carry.
5. Run `npm run check:spelling` and `npm run check:doc-links` bare and fix what they
   report.

### Gate

No tests and no TypeScript are touched, so the part gate's `<touched-tests>` /
`<touched-files>` resolve to the documentation checks. Run each bare, check `$?`, only
then commit:

```
npm run check:spelling
npm run check:doc-links
npm run check:doc-coverage
```

### Commit

`docs: refresh the published benchmark numbers and the pack-registry internals page`
