# Plan — the benchmark snapshot publishes again, the bench summary renders tsgit-only scenarios, `adr-lint` runs clean

> Source: design doc `docs/design/bench-snapshot-summary-adr-lint.md` · ADRs 800, 801, 802, 803, 804, 805, 806, 807, 808, 809
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the part schema — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness suites, docs/prose) with no `src/` delta ARE standalone — they have no
  implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

Seven parts. Parts 1–4 and 6–7 have no `src/` delta (bench files, the bench DSL, two
tooling scripts, a CI workflow field, documentation, dependency metadata) and are
legitimately standalone. Part 5 is the only `src/` part and carries every one of its
tests — unit, adapter and cross-tool interop — in the same commit.

## Working agreements — every part

- **Part gate**, verbatim, with the placeholders resolved per part:
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files> && npm run check:spelling`
- **Phase gate**, once, after part 7: `npm run validate`.
- Parts are sequential in ONE working tree and build on each other. Land them in order.
- Never run two wireit scripts concurrently in this tree. If a gate times out on tests
  outside the diff, that is oversubscription — re-run with `WIREIT_PARALLEL=1`. Never
  `--no-verify`.
- Never commit on a red gate. One atomic conventional commit per part, message given.
- No provenance references (phase, ADR, backlog or decision numbers) inside source or
  test code or in a commit subject — the commit is the join point.
- No suppression directives of any flavour (`@ts-ignore`, `biome-ignore`, `v8 ignore`,
  `stryker-disable`). No swallowed errors.
- State-mutating probes against real `git` run in a `mktemp -d` throwaway with an
  isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed and signing off —
  never in this worktree, whose `.git/config` is shared with every sibling worktree.

### Repository facts the parts rely on — verified, do not re-derive

- `biome.json`'s `files.includes` is an opt-in **whitelist**. A `tooling/` file absent
  from it is silently unlinted (`biome check` reports the path as ignored). Today it
  lists `tooling/bench-to-snapshot.ts` and `tooling/test/unit/bench-to-snapshot.test.ts`
  but **not** `tooling/bench-summarize.ts`.
- `vitest.config.ts`'s `unit` project already globs `tooling/test/unit/**/*.test.ts`,
  so a new tooling unit test needs no config change.
- `vitest.config.ts`'s coverage `include` list is `src/domain/**`, `src/ports/**`,
  `src/adapters/node/**`, `src/adapters/memory/**`, `src/operators/**`. It does **not**
  cover `src/application/**`, so part 5's file carries no line-coverage gate; the
  mutation harness, which mutates all of `src`, is its only mechanical guard. That is
  why part 5's tests isolate one condition each.
- `npm run check:spelling` runs cspell over `src/**/*.ts`, `test/**/*.ts`,
  `docs/**/*.md` and `*.md` — **not** over `tooling/**`.
- `reports/*` is gitignored except `reports/api.json`, so every bench artefact
  (`reports/benchmarks/raw.json`, `summary.md`, `snapshot.json`) stays out of every
  commit. Confirm with `git status --porcelain` after any bench run.
- `vitest.bench.config.ts` sets `benchmark.outputJson: 'reports/benchmarks/raw.json'`;
  a single-file bench run overwrites that file with only that file's groups.
- Installed and pinned for this work: vitest 4.1.11, tinybench 2.9.0. `BenchOptions` is
  vitest's re-export of tinybench's `Options` (`node_modules/vitest/dist/index.d.ts`
  line 29), and `Options.throws?: boolean` exists
  (`node_modules/tinybench/dist/index.d.ts` line 205) — `throws` needs no cast.
- Commit subjects are capped at 100 characters (`commitlint.config.js`).
- The lint-staged hook runs `biome check --write` and `vitest related --run --project unit`
  on staged `.ts` files only; it spell-checks nothing. Markdown-only commits run neither.

### The zero-sample check — one command, used by parts 1 and 2

After any `vitest bench` run, this is the assertion that a green exit code does not give
you (a benchmark that threw in warmup is reported as a pass with `samples: []`):

```bash
node -e "const r=require('./reports/benchmarks/raw.json');const bad=r.files.flatMap(f=>f.groups.flatMap(g=>g.benchmarks.filter(b=>!(b.sampleCount>0)).map(b=>g.fullName+' > '+b.name)));console.log(bad.length===0?('OK — '+r.files.flatMap(f=>f.groups.flatMap(g=>g.benchmarks)).length+' entries, all sampled'):('ZERO-SAMPLE: '+bad.join(' | ')));process.exit(bad.length===0?0:1)"
```

## Decision candidates

Every load-bearing choice the accepted decisions did not already settle. The part text
below is written against the recommendation; a different ruling changes only the named
step, never the part boundaries.

| # | Choice | Alternatives | Recommendation | Why |
|---|---|---|---|---|
| P1 | Whether the already-present receive path also drops this Context's cached pack registry (part 5) | (a) call `refreshPackRegistry(ctx)`, exactly as the promote path does; (b) skip it — this call wrote nothing, so nothing it did invalidates the cache | **(a)** | The registry is keyed on `ctx.session` and caches the `objects/pack` scan. A Context that warmed its registry before some other writer landed the pack would, without the refresh, keep reporting the pack's objects as absent after a receive that reports success — the exact failure the promote path's own comment records `pull` hitting. git holds no such cache, so refreshing is the git-faithful side. (b) is one fewer line and one fewer test, at the cost of a real, narrow correctness hole. |
| P2 | Where the already-present check sits relative to the entry walk (part 5) | (a) after `indexQuarantinedPack`, immediately before the rename; (b) right after the trailer verifies, before the walk, skipping the index pass entirely | **(a)** | The accepted decision fixes "before the rename" and no further. (a) keeps `objectCount` truthful on the already-present path (it is the count this call actually walked) and keeps the verify-before-trust ordering intact — a malformed pack that merely looks like a duplicate still throws. It also matches git, which indexes the whole stream before its move step discovers the destination is occupied. (b) is faster but returns an `objectCount` it never measured and would accept a corrupt body whose trailer happens to name an existing pack. |
| P3 | What `toSnapshotEntries` does with a benchmark carrying neither `median` nor `mean`, now that `mean` is optional (part 3) | (a) skip it — `flatMap` to zero entries; (b) emit `value: Number.NaN`; (c) widen `SnapshotEntry.value` to `number \| undefined` | **(a)** | With `mean` optional, `bench.median ?? bench.mean` is `number \| undefined` and stops type-checking, so something must give. (a) keeps the published `SnapshotEntry` shape exactly as its accepted decision fixed it, stays total, and reaches `tooling/bench-check.ts` as a scenario absent from one side — which is precisely that tool's own `missing` verdict. (b) puts a silent poison value in the published series. (c) propagates the lie into the type the publish action consumes. Note that today's runtime behaviour — an entry whose `value` key `JSON.stringify` drops — is the defect, not a semantic worth preserving. |
| P4 | The shape of `renderSummary`'s `environment` parameter (part 4) | (a) a field-per-fact interface: `{ generatedAt, platform, arch, nodeVersion, cpuModel }`; (b) one pre-rendered `{ generatedAt, host }` string pair; (c) inject a clock and an `os` reader as function parameters | **(a)** | The renderer stays the only place that knows the header's byte layout, which is what makes the byte-identical assertion meaningful, and `main()` stays the only reader of the clock, `process` and `os`. (b) moves half the format string into `main()`, where no test can see it. (c) is dependency injection for two reads that have exactly one caller. |
| P5 | Where the re-receive interop test lives, and how the node adapter gets covered (part 5) | (a) a new `test/integration/pack-receive-idempotence-interop.test.ts` with its own `@proves` header, driving a **node** context so the node adapter is covered by the same test; (b) a new describe block inside the existing index-pack interop file; (c) a memory-only unit test plus a cross-adapter parity scenario | **(a)** | A dedicated file states one claim, carries its own small fixture (three commits plus `repack -a -d`, seconds rather than a 300-commit fast-import), and covers the node adapter where it matters — on a real filesystem, against real `git` in the same fixture. (b) reuses a heavyweight fixture and leaves the host file's `unique:` claim no longer describing the file. (c) cannot prove faithfulness at all: parity tests are cross-adapter and compare tsgit against tsgit. |

## Part 1 — the fetch-pack bench receives into a fresh destination

### Context

The single file in scope is `test/bench/fetch-pack.bench.ts` (81 lines). It is the only
benchmark in the suite that has never measured anything: it builds one memory context in
the scenario's `build` callback and receives the same pack into that same context on
every iteration, so the second call renames its quarantined pack over the existing
`.pack` and then throws `FILE_EXISTS` on `pack-<sha>.idx`.

Current shape, all of it load-bearing:

- Imports: `createMemoryContext` from `../../src/adapters/memory/memory-adapter.js`;
  `fetchPack` and the type `NegotiatePackBytes` from
  `../../src/application/primitives/fetch-pack.js`; the type `ObjectId` from
  `../../src/domain/objects/index.js`; `buildSyntheticPack` and the type `EntrySpec`
  from `../unit/application/primitives/pack-fixture.js`; `benchScenario` from
  `./support/bench-dsl.js`.
- Module constants `const ENCODER = new TextEncoder()`, `const CHAIN_DEPTH = 200`,
  `const CHAIN_COUNT = 8` — unchanged.
- `const buildChainedEntries = (): EntrySpec[]` — unchanged. Produces 1608 entries
  (eight independent linear OFS chains, 200 deep each) over 247,544 pack bytes.
- `const toNegotiator = (packBytes: Uint8Array): NegotiatePackBytes => async () => ({ packBody: (async function* () { yield packBytes; })(), shallow: [], unshallow: [] })`
  — unchanged. A fresh generator per call, so one negotiator serves any number of
  receives.
- The `benchScenario(given, whenThen, build)` call. Its two title strings are the
  published snapshot series key and must stay **byte-identical, verbatim**:
  - `'Given a pack with 8 independent 200-deep OFS delta chains'`
  - `'When fetchPack receives and indexes it in two passes, Then measure tsgit'`
  The bench name the DSL registers stays `tsgit`. A renamed key silently starts a new
  gh-pages series and orphans the old one.
- `build` today: `const ctx = createMemoryContext(); const built = await buildSyntheticPack(ctx, buildChainedEntries()); const negotiator = toNegotiator(built.packBytes);`
  then returns `{ sut }` where `sut: () => Promise<void>` calls
  `fetchPack(ctx, negotiator, { wants: [(built.ids[0] ?? 'a'.repeat(40)) as ObjectId], haves: [], capabilities: ['side-band-64k', 'ofs-delta'], progressOp: 'test:write-objects' })`
  and ends with `if (result.packPath === '') throw new Error('fetchPack wrote no pack');`.

The change is which context `sut` receives into, and nothing else:

- `buildSyntheticPack(ctx, entries)` (see `test/unit/application/primitives/pack-fixture.ts`,
  the function body spanning lines 82–166) reaches the context **only** through
  `ctx.compressor.deflate` and `ctx.hash.hashHex`, and writes nothing. The produced pack
  bytes therefore depend on the hash algorithm, not on the store, so the pack is built
  once in `build` and replayed into any number of destinations.
- `build` keeps: one seed context used solely to construct the pack, the entry list, the
  built pack, the negotiator closure and the wanted id.
- `sut` becomes `fetchPack(createMemoryContext(), negotiator, { … })` — the same input
  object, a brand-new empty destination per iteration, the `packPath === ''` guard kept.
- Rename the seed binding so the two roles cannot be confused (`ctx` → a name that says
  it only hashes and compresses).
- The comment claiming *"The packs land in the memory adapter's own store; it dies with
  the worker, so there is nothing on disk to release"* is now false and must be replaced:
  each iteration's store is unreachable once the iteration returns, so the scenario no
  longer accumulates.

Why a fresh destination rather than cleaning up after each call — probed, not assumed:
removing the `.pack` and `.idx` between calls still throws `FILE_EXISTS` on
`pack-<sha>.rev`; the writer's artefact list grew by `.rev` one phase ago and will grow
again, so the removal shape is coupled to it by construction. A fresh context also keeps
the delta cache cold, which is what a real receive faces, where a shared context would
serve iterations 2..n warm and price something the scenario does not claim to measure.
Measured cost of constructing a memory context: 0.0011 ms against a ~35 ms iteration,
about 0.003%.

Two boundaries this part must not cross:

- The receive path it measures is `fetchPack → materializePack → indexQuarantinedPack →
  writePackSiblingArtifacts` in src/application/primitives/fetch-pack.ts. Part 5 changes
  that path; part 1 must not touch it and must not depend on it, because a tolerant
  receive path would let a second receive into an occupied destination skip the sibling
  writes and price a different code path.
- The DSL entry point is `benchScenario(given, whenThen, build, opts)` in
  test/bench/support/bench-dsl.ts. Part 2 changes it; part 1 must not.

Nothing in `tooling/` or `.github/` changes here.

### TDD steps

There is no vitest test for a bench scenario, and a green `vitest bench` exit code
proves nothing — that is the defect. The RED is therefore an explicit measurement probe,
run and recorded before the edit.

1. **RED (probe, before any edit).** Run
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/fetch-pack.bench.ts`
   then the zero-sample check from *Working agreements*. Expected failure: the check
   exits 1 and names
   `Given a pack with 8 independent 200-deep OFS delta chains, When fetchPack receives and indexes it in two passes, Then measure tsgit > tsgit`
   — the entry carries `samples: []`, no `sampleCount`, no `median`, no `mean`, no `hz`,
   while `vitest bench` itself exited 0. Save a copy of the entry's `fullName` string;
   it is the series key the GREEN run must reproduce byte-for-byte.
2. **GREEN.** Apply the fresh-destination edit: `build` constructs the pack through a
   seed context; `sut` calls `fetchPack(createMemoryContext(), negotiator, { … })`.
   Re-run the same two commands. The check must exit 0, the entry must carry
   `sampleCount > 0` and a numeric `median`, and its `fullName` must be byte-identical
   to the string saved in step 1 (compare the two strings explicitly, do not eyeball).
3. **REFACTOR.** Replace the stale store-lifetime comment with one that says why a fresh
   destination is required (cold cache per iteration, immunity to the writer's artefact
   list). Rename the seed binding. Re-run step 2's commands — the numbers move, the key
   does not.
4. Confirm `git status --porcelain` shows only `test/bench/fetch-pack.bench.ts`.

### Gate

```bash
npx vitest run tooling/test/unit/bench-dsl.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/bench/fetch-pack.bench.ts \
  && npm run check:spelling
```

`<touched-tests>` resolves to `tooling/test/unit/bench-dsl.test.ts` — this part touches
no vitest test of its own, and that is the only unit test covering the DSL this bench
file registers through. The measurement proof is the extra, non-negotiable step:

```bash
npx vitest bench --run --config vitest.bench.config.ts test/bench/fetch-pack.bench.ts
# then the zero-sample check from Working agreements — must exit 0
```

### Commit

`fix(bench): receive into a fresh memory context on every fetch-pack iteration`

## Part 2 — the bench DSL fails a warmup throw, and the snapshot job is time-bounded

### Context

Two files carry the change plus one workflow field. The mechanism, pinned against the
installed vitest 4.1.11 and tinybench 2.9.0: `bench(name, fn, options)` stores the
options object verbatim and vitest's benchmark runner passes it straight to
`new Bench(...)`, which reads `throws` off it. Without `throws`, tinybench's `warmup`
stores the error on the task and returns; `run` then returns early on that stored error
**before** dispatching either the `complete` or the `error` event, and vitest listens for
nothing else — so the task keeps the placeholder result the runner built for it
(`{ name, rank: 0, rme: 0, samples: [] }`), the suite is marked pass, and the process
exits 0.

**`test/bench/support/bench-dsl.ts`** (96 lines). Current symbols:

- `export interface BenchComparison { readonly sut: () => Promise<void> | void; readonly baseline?: () => Promise<void> | void; readonly teardown?: () => Promise<void> | void }`
- `type Teardown = () => Promise<void> | void;` and `type HookMode = 'warmup' | 'run';`
- `export const onMeasuredRun = (teardown: Teardown) => (mode: HookMode): Promise<void> | void => mode === 'run' ? teardown() : undefined;`
- `export interface MeasuredRunHooks extends BenchOptions { readonly teardown: (task: unknown, mode: HookMode) => Promise<void> | void }` — the `teardown` field is **required** today.
- `const afterMeasuredRun = (teardown: Teardown): MeasuredRunHooks => ({ teardown: (_task, mode) => onMeasuredRun(teardown)(mode) });`
- `export interface ScenarioHooks { readonly tsgit?: MeasuredRunHooks; readonly baseline?: MeasuredRunHooks }`
- `export const hooksFor = (comparison: BenchComparison): ScenarioHooks` — early-returns
  `{}` when `comparison.teardown === undefined`; otherwise builds one hooks object and
  returns `{ tsgit: hooks }` when there is no baseline, `{ baseline: hooks }` when there is.
- `export interface BenchScenarioOptions { readonly skip?: boolean }`
- `export const benchScenario = (given, whenThen, build, opts = {}) => { … bench('tsgit', comparison.sut, hooks.tsgit); if (comparison.baseline !== undefined) { bench('isomorphic-git', comparison.baseline, hooks.baseline); } }`

`MeasuredRunHooks` and `ScenarioHooks` have no consumer outside this file (grep over
`src`, `test` and `tooling` returns only bench-dsl.ts itself), so their shape is free to
change.

Target shape: **one** options interface that always carries `throws: true` and carries
the teardown optionally, with `ScenarioHooks`' two fields becoming REQUIRED (every bench
now gets options). The REDs below read them through `?.` so they fail as assertions
rather than as a `TypeError` while the fields are still optional; once GREEN lands and
the fields are required, drop the optional chaining if biome asks for it. `hooksFor`
returns options for BOTH benches, always; the
teardown routing is unchanged — it still rides the scenario's LAST bench so a baseline
still measures on an intact scratch copy, and `onMeasuredRun` still ignores `'warmup'`;
`benchScenario` always passes the resolved options to `bench(...)`.

One existing contract becomes load-bearing in a new way and must be left alone:
`removeSync` in test/bench/support/fixture-scratch.ts swallows and logs. tinybench
invokes the teardown hook un-awaited and inside `run`'s own body, so a teardown that
throws lands in the same never-resolving promise as a run-phase failure. Under
`throws: true` that swallow stops being defensive and becomes what keeps a cleanup
failure from hanging the runner. Do not "tidy" it into a rethrow; record the invariant in
the DSL's doc comment instead.

**`tooling/test/unit/bench-dsl.test.ts`** (95 lines, `unit` project, already in the biome
whitelist). It imports `{ hooksFor, onMeasuredRun } from '../../../test/bench/support/bench-dsl.ts'`.
Module-level helpers at the top: `const noop = (): void => undefined;` and
`const noTask = undefined;` — the hook never reads its task argument, and vitest's
`BenchFactory` / `BenchTask` are type-only re-exports that cannot be constructed here, so
`undefined` is passed for it. Existing cases:

- `describe('onMeasuredRun')` — two cases, `'warmup'` does not call the teardown,
  `'run'` calls it exactly once. Unchanged by this part.
- `describe('hooksFor')` > `describe('Given a comparison without a teardown')` >
  `describe('When hooksFor routes it')` > `it('Then neither bench receives options')`,
  asserting `expect(result).toEqual({})` on the input `{ sut: noop, baseline: noop }`.
  This case must be **rewritten**, not deleted.
- `describe('Given a tsgit-only comparison with a teardown')` — asserts the warmup/run
  routing and `expect(Object.hasOwn(result, 'baseline')).toBe(false)`.
- `describe('Given a comparison with a baseline and a teardown')` — asserts the teardown
  fires from the baseline and `expect(Object.hasOwn(result, 'tsgit')).toBe(false)`.

Both `Object.hasOwn(...)` assertions stop being true once every bench receives options;
they become assertions that the OTHER bench's options carry no teardown.

**`.github/workflows/ci.yml`.** The `benchmark-snapshot` job begins at line 562:

```yaml
  benchmark-snapshot:
    if: github.event_name == 'push'
    needs: [unit-tests]
    runs-on: ubuntu-latest
    permissions:
      contents: write
```

No job anywhere in that file sets `timeout-minutes`. Add `timeout-minutes: 30`
immediately after `runs-on: ubuntu-latest`, the same placement and the same number
`.github/workflows/bench.yml` already uses at its line 19. Rationale to record nowhere in
code but to know while editing: with `throws: true`, an error raised during a benchmark's
**run** phase (after warmup) rejects inside the timer callback vitest wraps the run in,
that promise never settles, and the worker hangs — unbounded, it would burn GitHub's
360-minute default.

Two consequences of `throws: true`, both deliberate and both recorded in the DSL's doc
comment so a future reader does not diagnose them as fresh defects:

- A warmup failure aborts the **whole bench file** — scenarios declared after the failing
  one never run, so a truncated `raw.json` is expected, not a second bug.
- tinybench fires the bench-level teardown hook with mode `warmup` before raising, which
  `onMeasuredRun` deliberately ignores, so a copy-based scenario's scratch directory is
  left behind. That is the already-accepted cost of the scratch posture;
  `bench:fixture -- --prune` is the reclaimer.

Exposure of applying `throws: true` to all 30 bench files: the current nightly artefact
has exactly **one** sample-less entry out of 109 — the fetch-pack scenario part 1 fixes.
The sweep is expected green on part 1 alone. If a different scenario surfaces, its fix
rides in this PR (there are no follow-ups); if the fix is not small, escalate
`{ scenario, reason, ≤3 options }` rather than suppressing it.

### TDD steps

1. **RED 1.** Rewrite `it('Then neither bench receives options')` under
   `describe('Given a comparison without a teardown')`, narrowing its input to the
   tsgit-only shape `{ sut: noop }` and retitling it to
   `Then both benches receive throwing options and neither carries a teardown`. Assert
   `result.tsgit?.throws === true`, `result.baseline?.throws === true`,
   `result.tsgit?.teardown === undefined`, `result.baseline?.teardown === undefined`.
   Expected failure: `hooksFor` returns `{}`, so every one of the four reads is
   `undefined`.
2. **RED 2.** Add a sibling case `describe('Given a comparison with a baseline and no teardown')`
   over the input `{ sut: noop, baseline: noop }` with the same four assertions. This
   isolates the second half of the no-teardown branch, which RED 1 no longer covers.
   Expected failure: same.
3. **RED 3.** Amend `Given a tsgit-only comparison with a teardown`: keep the warmup/run
   assertions verbatim, replace `expect(Object.hasOwn(result, 'baseline')).toBe(false)`
   with `expect(result.baseline?.throws).toBe(true)` and
   `expect(result.baseline?.teardown).toBeUndefined()`. Expected failure:
   `result.baseline` is `undefined`.
4. **RED 4.** Amend `Given a comparison with a baseline and a teardown` symmetrically:
   keep `expect(teardown).toHaveBeenCalledTimes(1)` after
   `await result.baseline?.teardown?.(noTask, 'run')`, replace the `Object.hasOwn`
   assertion with `expect(result.tsgit?.throws).toBe(true)` and
   `expect(result.tsgit?.teardown).toBeUndefined()`. Expected failure: `result.tsgit` is
   `undefined`.
5. **GREEN.** In `bench-dsl.ts`: give the options interface an always-`true` `throws`
   field and an OPTIONAL teardown; drop `hooksFor`'s early return so it returns options
   for both benches in every case, attaching the teardown to the last bench exactly as
   before; make `ScenarioHooks`' two fields required; have `benchScenario` pass
   `hooks.tsgit` and `hooks.baseline` unconditionally. All four cases go green.
6. **RED 5 (workflow).** No unit test can assert a YAML job field. The RED is
   `grep -n 'timeout-minutes' .github/workflows/ci.yml` printing nothing. **GREEN:** add
   the line; re-run the grep and expect exactly one hit, inside the `benchmark-snapshot`
   job. Confirm the file still parses as a workflow by eye against bench.yml's shape.
7. **REFACTOR.** The DSL's module doc comment records three things: the file-wide abort
   on a warmup throw, the run-phase hang that the workflow timeout bounds, and why
   `removeSync`'s swallow must not become a rethrow. Update `BenchComparison.teardown`'s
   existing doc note if it now understates the abort.
8. **Suite-level proof.** Run the whole sweep, then the zero-sample check across every
   entry (see *Gate*). This is the only thing that proves no OTHER scenario was failing
   silently and has now gone red. Record the entry count and the number of skipped
   scenarios — a scaled scenario whose fixture cannot be built is `skip`ped and emits no
   group at all, so a skip is not a false green but it does shrink the denominator.

### Gate

```bash
npx vitest run tooling/test/unit/bench-dsl.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/bench/support/bench-dsl.ts tooling/test/unit/bench-dsl.test.ts \
  && npm run check:spelling
```

`biome` is not given the workflow file — YAML is outside its `files.includes`. Then, and
this part cannot land without it:

```bash
npx vitest bench --run --config vitest.bench.config.ts
# then the zero-sample check from Working agreements — must exit 0 over EVERY entry
```

The sweep builds or reuses the scaled fixtures under `~/.cache/tsgit-bench` and can take
tens of minutes on a cold cache. Do not shorten it to the fetch-pack file: a single-file
run cannot prove the repo-wide claim this part makes.

### Commit

`fix(bench): fail the run on a warmup throw and bound the snapshot job at 30 minutes`

## Part 3 — the snapshot converter refuses a benchmark it cannot value

### Context

One script and its existing unit test.

**`tooling/bench-to-snapshot.ts`** (121 lines) is already whitelisted in biome.json,
already exports its pure functions and already guards `main()` — it is the house pattern
part 4 copies. Current symbols:

- `interface RawBenchmark { readonly name: string; readonly mean: number; readonly median?: number }`
  — the declared `mean: number` is a lie at runtime. vitest emits the placeholder
  `{ id, name, rank, rme: 0, samples: [] }` for a benchmark that threw in warmup, with
  neither `mean` nor `median`. `mean` becomes optional.
- `interface RawGroup { readonly fullName: string; readonly benchmarks: ReadonlyArray<RawBenchmark> }`,
  `interface RawFile { readonly groups: ReadonlyArray<RawGroup> }`,
  `export interface RawReport { readonly files: ReadonlyArray<RawFile> }`.
- `export interface SnapshotEntry { readonly name: string; readonly unit: 'ms'; readonly value: number }`
  — the shape an accepted decision fixes. Do NOT widen `value`.
- `export interface StampedSnapshotEntry extends SnapshotEntry { readonly extra: string }`.
- `export const toSnapshotEntries = (raw: RawReport): SnapshotEntry[]` — a `flatMap` over
  files → groups → benchmarks producing
  `{ name: \`${group.fullName} > ${bench.name}\`, unit: 'ms' as const, value: bench.median ?? bench.mean }`.
  Once `mean` is optional that expression types as `number | undefined` and stops
  compiling — decision candidate P3 settles what replaces it. The metric
  (`median ?? mean` in ms) and the `"<group> > <bench>"` key are fixed by an accepted
  decision and do not change.
- `export const withNodeVersion(entries, resolvedNodeVersion)`,
  `export const resolveNodeVersion(env)`.
- `const ROOT`, `const RAW = <root>/reports/benchmarks/raw.json`,
  `const OUT = <root>/reports/benchmarks/snapshot.json`.
- `const main = async (): Promise<void>` at line 103 —
  `resolveNodeVersion(process.env)`, then `JSON.parse(await readFile(RAW, 'utf8')) as RawReport`,
  then `withNodeVersion(toSnapshotEntries(raw), resolvedNodeVersion)`, then
  `writeFile(OUT, …)`, then a `Wrote N snapshot entries to <path>` line on stdout.
- `const invokedDirectly = (): boolean` at lines 111–114:
  `const entry = process.argv[1]; return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);`
  and the `if (invokedDirectly()) { main().catch(…) }` tail that exits 1 with the message
  on stderr.

The guard goes in `main()` **between the parse and the conversion**, so `snapshot.json` is
never written when an offender is present and the publish action never sees a partial
file. It is a separate exported pure function, not a check inside `toSnapshotEntries`,
because `tooling/bench-check.ts` also imports `toSnapshotEntries` and runs label-gated on
a `continue-on-error` job, where a hard throw is noise and would foreclose that tool's own
`missing` verdict. `bench-check.ts` is not edited by this part and must not inherit the
refusal.

The refusal message names **every** offender, each as `"<group fullName> > <bench name>"`
— the same key `toSnapshotEntries` produces, so the operator can grep the raw report for
it directly. Name the export `assertEveryBenchmarkValued`; it takes the parsed report and
returns it unchanged when every benchmark yields a value, and throws otherwise. It is
INTERNAL to `tooling/`: nothing under `src/` imports it, it reaches no barrel and no
library user, so it trips no public-surface gate and `reports/api.json` needs no
regeneration for this part.

**`tooling/test/unit/bench-to-snapshot.test.ts`** (already whitelisted, `unit` project).
It imports `{ type RawReport, resolveNodeVersion, toSnapshotEntries, withNodeVersion } from '../../bench-to-snapshot.js'`
— the `.js` specifier is the house form for a tooling test importing its subject. Its
existing tree is `describe('toSnapshotEntries')` > `describe('Given …')` >
`describe('When toSnapshotEntries runs')` > `it('Then …')`, AAA bodies with
`// Arrange` / `// Act` / `// Assert` markers, fixtures built as inline `RawReport`
object literals with group names like `'log:walk'`. Extend that file; do not add a new
one.

Assertion discipline for the refusal: assert the error's **message text and every
offender key**, never `toThrow(Error)` — a bare class assertion cannot tell a
string-literal mutant from the real message, and `bareClassToThrow` is a gating heuristic
in this repository.

### TDD steps

1. **RED 1.** New top-level `describe('assertEveryBenchmarkValued')` >
   `Given a report whose only benchmark carries neither median nor mean` >
   `When the guard runs` > `Then it throws naming that benchmark`. Build the report with
   one group `'log:walk'` and one benchmark `{ name: 'tsgit' }`. Use try/catch, then
   assert the caught error is an `Error` and that its `message` contains
   `'log:walk > tsgit'`. Expected failure: the exported symbol does not exist yet.
2. **RED 2.** `Given a report with two benchmarks carrying neither median nor mean` >
   `Then the message names both keys` — two groups in two files, both offenders asserted
   individually. Isolates "every offender, not just the first".
3. **RED 3.** `Given a benchmark with a mean and no median` > `Then the guard returns the report unchanged`
   — assert `result` is the same reference as the input (`toBe`).
4. **RED 4.** `Given a benchmark with a median and no mean` > `Then the guard returns the report unchanged`.
   RED 3 and RED 4 exist separately so each half of the `median ?? mean` condition is
   proven on its own; one test carrying both cannot.
5. **RED 5.** `Given a report with no files` > `Then the guard returns the report unchanged`
   — the empty edge of the same branch.
6. **RED 6.** Inside `describe('toSnapshotEntries')`:
   `Given a group holding one valued benchmark and one carrying neither median nor mean` >
   `Then only the valued benchmark becomes an entry` — asserts the exact one-element
   array. This is the behaviour decision candidate P3(a) chooses. vitest strips types
   rather than checking them, so the case runs today and fails on the value (a second
   entry whose `value` is `undefined`); `npm run check:types` stays red until step 7
   makes `mean` optional, which is expected and is not a reason to reorder.
7. **GREEN.** Make `RawBenchmark.mean` optional. Add two module-private helpers — one
   that reads a benchmark's value as `number | undefined`, one that builds the
   `"<group> > <bench>"` key — and use both from `toSnapshotEntries` (which now `flatMap`s
   a benchmark to zero or one entry) and from the new exported guard. Wire the guard into
   `main()` between `JSON.parse(...)` and `toSnapshotEntries(...)`.
8. **REFACTOR.** The module doc comment gains one sentence: the publish path refuses a
   value-less entry by name, and the comparison tool deliberately does not inherit that
   refusal.
9. **End-to-end refusal probe** (not a committed test — the script's `main()` is not unit
   testable). Delete any `reports/benchmarks/snapshot.json` a previous run left behind,
   write a hand-made `reports/benchmarks/raw.json` holding one group with one
   sample-less benchmark, run
   `RESOLVED_NODE_VERSION=24.0.0 node --experimental-strip-types tooling/bench-to-snapshot.ts`,
   and assert exit 1, the offender key on stderr, and `reports/benchmarks/snapshot.json`
   absent. Then regenerate a real `raw.json` with
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/fetch-pack.bench.ts`
   and re-run the script: exit 0, `snapshot.json` written. `reports/` is gitignored, so
   neither file enters the commit — confirm with `git status --porcelain`.

### Gate

```bash
npx vitest run tooling/test/unit/bench-to-snapshot.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check tooling/bench-to-snapshot.ts tooling/test/unit/bench-to-snapshot.test.ts \
  && npm run check:spelling
```

Plus the end-to-end refusal probe from TDD step 9, both halves.

### Commit

`fix(tooling): refuse a benchmark snapshot entry that carries no value`

## Part 4 — the bench summary renders tsgit-only scenarios

### Context

`tooling/bench-summarize.ts` (94 lines) requires **both** a `tsgit` and an
`isomorphic-git` entry in a group and otherwise emits
`| <scenario> | _missing entry_ | _missing entry_ | n/a |`. Rendering the real nightly
artefact through it produces 95 data rows, **81 of them blank**: the suite has 14 paired
groups and 81 tsgit-only groups, and no group without a `tsgit` entry at all. A reader of
`summary.md` sees 85% of the suite reported as not run.

Two mechanical facts about the file. It exports nothing and calls `main()` at import
(line 91), so no part of it is reachable from a test. And it is **not** in `biome.json`'s
`files.includes` whitelist, so it is silently unlinted today — its content is
nevertheless already clean under this repository's rule set, so the whitelist entry costs
nothing.

Current symbols, none exported:

- `interface BenchEntry { readonly name: string; readonly hz: number; readonly mean: number; readonly median?: number; readonly p99: number; readonly rme: number }`
- `interface BenchGroup { readonly fullName: string; readonly benchmarks: ReadonlyArray<BenchEntry> }`
- `interface BenchFile { readonly filepath: string; readonly groups: ReadonlyArray<BenchGroup> }`
- `interface RawReport { readonly files: ReadonlyArray<BenchFile> }`
- `const scenarioName = (fullName: string): string` — splits on `' > '`, returns the last
  part, falling back to `fullName`.
- `const findByName = (group: BenchGroup, name: string): BenchEntry | undefined`
- `const formatMs = (value: number): string => \`${value.toFixed(3)} ms\``
- `const formatHz = (value: number): string => \`${value.toFixed(0)}/s\``
- `const formatSpeedup = (a: number, b: number): string` — `'n/a'` when `b === 0`,
  otherwise `` `${(a / b).toFixed(2)}×` ``.
- `const renderRow = (group: BenchGroup): string` — the all-or-nothing guard, then
  `const tsgitMean = tsgit.median ?? tsgit.mean; const isoMean = iso.median ?? iso.mean;`
  and the row template
  `` `| ${scenario} | ${formatMs(tsgitMean)} (${formatHz(tsgit.hz)}, ±${tsgit.rme.toFixed(2)}%) | ${formatMs(isoMean)} (${formatHz(iso.hz)}, ±${iso.rme.toFixed(2)}%) | ${speedup} |` ``
  with `speedup = formatSpeedup(isoMean, tsgitMean)`.
- `const main = async (): Promise<void>` — reads `RAW`, flattens
  `raw.files.flatMap((file) => file.groups)`, and joins these lines with `'\n'`:
  `'# Benchmark results'`, `''`,
  `` `Generated ${new Date().toISOString()} on \`${process.platform}-${process.arch}\` (Node ${process.version}, ${os.cpus()[0]?.model ?? 'unknown CPU'}).` ``,
  `''`, `'| Scenario | tsgit | isomorphic-git | speedup (tsgit faster) |'`, `'|---|---|---|---|'`,
  `...groups.map(renderRow)`, `''`, the four-line block quote beginning
  `'> _speedup > 1×_ means tsgit beat isomorphic-git on median runtime. Raw'`, `''`.
  Then `writeFile(OUT, …)` and `Wrote <path>` on stdout.

Required rendering, an accepted decision:

| group shape | tsgit cell | baseline cell | speedup |
|---|---|---|---|
| paired (both entries measured) | `<median-else-mean> ms (<hz>/s, ±<rme>%)` | same, from the `isomorphic-git` entry | `<iso/tsgit>×`, or `n/a` when the tsgit value is zero |
| tsgit measured, no measured baseline | as above | a single em dash | `n/a` |
| no measured tsgit entry | `_missing entry_` | `_missing entry_` | `n/a` |

Paired rows keep their **exact current bytes** — same `toFixed` precisions, same `ms`,
`/s` and `±%` decorations, same `×` suffix, same column order. The anomaly branch is
uniform on purpose: any group that cannot produce a tsgit measurement renders BOTH cells
as `_missing entry_`, whatever the baseline holds. That row is an alarm, not a
comparison. The em dash reads as "no peer, by design"; an italic marker would read as a
failure, which is the confusion this part exists to remove.

**The renderer must be total, and that is not optional.** Today's all-or-nothing guard
accidentally protects the formatters: the one entry in the suite with no samples sits in
a tsgit-only group and never reaches `formatMs`. The moment a tsgit-only group formats
its own cell, that entry reaches `formatMs(undefined)` and crashes `npm run bench:summary`
on the very artefact this part is meant to fix. So `BenchEntry` gets the same reality
check the converter's raw type gets — `mean` and `hz` become optional, `median` already
is — and one predicate decides a cell: **an entry counts as measured when `median ?? mean`
is a number and `hz` is a number**. vitest emits those fields together (a task carries
either a full result or the `{ id, name, rank, rme, samples }` placeholder), so the two
conditions never disagree in practice; the predicate is what makes that a checked fact
rather than an assumption. A group whose `isomorphic-git` entry exists but is not
measured renders as tsgit-only — the baseline cell only ever carries a number when the
baseline entry is itself measured.

The two-name keying (`findByName(group, 'tsgit')` and `findByName(group, 'isomorphic-git')`)
is untouched: the runnable bench set stays at exactly two names, so no N-competitor
renderer ships.

Extraction shape, an accepted decision — mirror tooling/bench-to-snapshot.ts rather than
growing a second module:

- `renderRow(group)` becomes exported. It is already pure.
- A new exported `renderSummary(raw, environment)` builds the whole document. The three
  impure inputs `main()` inlines today — the timestamp, the platform/arch/Node triple and
  the CPU model — move into the `environment` parameter (decision candidate P4), so the
  document is deterministic under test. `main()` becomes the only place that reads the
  clock, `process` and `os`.
- `main()` is guarded by the same invoked-directly predicate bench-to-snapshot.ts uses:
  resolve `process.argv[1]` and compare it to `fileURLToPath(import.meta.url)`. Copy it
  verbatim; the file already imports `node:path` as `path` and `node:url` as `url`, so no
  new import specifier is introduced. Importing the module must then run nothing.
- Export the `RawReport` and `BenchGroup` types so the test can build typed fixtures, and
  name the new parameter's type `SummaryEnvironment`, exactly as bench-to-snapshot.ts
  exports `RawReport`. Each script keeps its OWN minimal view of the vitest schema;
  sharing types between the two is foreclosed.
- Every one of these exports is INTERNAL to `tooling/`: nothing under `src/` imports the
  script, it reaches no barrel and no library user, so none of them trips a
  public-surface gate and `reports/api.json` needs no regeneration. `check:dead-code`
  (knip) is satisfied because the new unit test imports them — the same arrangement
  bench-to-snapshot.ts already ships.

New file **`tooling/test/unit/bench-summarize.test.ts`**. The `unit` project already globs
`tooling/test/unit/**/*.test.ts`, so no config change. Mirror
tooling/test/unit/bench-to-snapshot.test.ts: import the subject as
`'../../bench-summarize.js'`, Given/When/Then describe tree, AAA bodies with section
comments, `sut` bound to the function under test (never to a result), synthetic
`RawReport` literals only — no artefact on disk.

**`biome.json`** — the `files.includes` array (lines 10–43) gains
`"tooling/bench-summarize.ts"` and `"tooling/test/unit/bench-summarize.test.ts"`. The
array is an opt-in whitelist; an unlisted file is silently unlinted, so both entries are
mandatory. Place them next to the existing `tooling/bench-to-snapshot.ts` /
`tooling/test/unit/bench-to-snapshot.test.ts` pair.

Nothing about `npm run bench:summary` changes: the same wireit script
(`node --experimental-strip-types tooling/bench-summarize.ts`), the same declared
`files` and `output` paths, the same `Wrote …` line.

The code in this part is independent of parts 1–3 and 5 and is safe on today's artefact,
whichever order it lands in. Only TDD step 14's "count must be 0" reading assumes parts 1
and 2 already landed, which the ordering of this plan guarantees.

### TDD steps

Each case isolates one branch; the unit test is the only mechanical guard this file will
ever have, since `tooling/` sits outside the coverage and mutation gates.

1. **RED 1.** `describe('renderRow')` > `Given a group with a measured tsgit entry and a measured isomorphic-git entry` >
   `When renderRow renders it` > `Then the row carries both cells and the speedup`.
   Assert the exact row string, byte for byte. Build the expected string from the row
   template quoted in this part's Context block, then cross-check the shape against a
   real paired row the current script produces —
   `| … | 3.698 ms (256/s, ±5.26%) | 1.233 ms (529/s, ±13.78%) | 0.33× |` — so the
   assertion is anchored to observed output, not to a re-reading of the template.
   Expected failure: `renderRow` is not exported.
2. **RED 2.** `Given a group with a measured tsgit entry and no isomorphic-git entry` >
   `Then the tsgit cell renders as in a paired row, the baseline cell is an em dash and the speedup is n/a`.
3. **RED 3.** `Given a group holding only an isomorphic-git entry` >
   `Then both cells render as missing`.
4. **RED 4.** `Given a group with an empty benchmark list` > `Then both cells render as missing`
   — the no-entry edge of the same branch.
5. **RED 5.** `Given a tsgit entry with a mean and no median` > `Then the cell is built from the mean`.
6. **RED 6.** `Given a tsgit-only group whose entry carries neither median nor mean nor hz` >
   `Then both cells render as missing and nothing throws` — this is the real shape in
   today's artefact and the reason the predicate exists.
7. **RED 7.** `Given a tsgit entry with a median and no hz` > `Then both cells render as missing`
   — isolates the second half of the predicate, which RED 6 cannot.
8. **RED 8.** `Given a group whose tsgit entry is measured and whose isomorphic-git entry is not` >
   `Then the row renders as a tsgit-only row` — pins that an unmeasured baseline is not a
   baseline.
9. **RED 9.** `Given a paired group whose tsgit value is zero` > `Then the speedup reads n/a`
   — not `Infinity×`.
10. **RED 10.** `describe('renderSummary')` >
    `Given a report with one paired group and one tsgit-only group and a fixed environment` >
    `Then the document carries the header, the table header, one row per group in file-then-group order, and the footnote`.
    Assert the whole string. Expected failure: `renderSummary` does not exist.
11. **RED 11.** `Given a report with no files and a fixed environment` >
    `Then the document carries the header and the footnote and no rows`.
12. **GREEN.** Widen `BenchEntry` (`mean` and `hz` optional); add the measured predicate
    and a cell builder; rewrite `renderRow`'s branches; export `renderRow`, the new
    `renderSummary`, and the `RawReport` / `BenchGroup` / `SummaryEnvironment` types; move
    the three impure reads into `main()`; guard `main()` with the invoked-directly predicate;
    add the footnote clause saying the speedup column applies to paired rows only.
13. **REFACTOR.** Add both whitelist entries to `biome.json` and run
    `./node_modules/.bin/biome check` over the two files — the script was unlinted until
    now, so this is the first time the rule set sees it. Fix anything it reports honestly;
    never silence it.
14. **Real-artefact check.** With a `reports/benchmarks/raw.json` in place, run
    `node --experimental-strip-types tooling/bench-summarize.ts` and count rows containing
    `_missing entry_`. Against a locally re-measured artefact (parts 1–2 landed) the count
    must be **0**. Against a hand-made pre-fix artefact holding one sample-less entry the
    count must be **1** — that scenario, correctly flagged as unmeasured — down from
    today's 81. Record both counts; reporting only the zero would hide which artefact was
    used. Confirm `git status --porcelain` shows only the three tracked files.

### Gate

```bash
npx vitest run tooling/test/unit/bench-summarize.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check tooling/bench-summarize.ts tooling/test/unit/bench-summarize.test.ts biome.json \
  && npm run check:spelling
```

### Commit

`fix(tooling): render tsgit-only scenarios in the benchmark summary`

## Part 5 — the receive path tolerates an already-present pack

### Context

The only `src/` change in this plan, and the only one with a faithfulness claim.

**What git does**, pinned against git 2.55.0 in a `mktemp` throwaway with every `GIT_*`
scrubbed, an isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1` and signing off:

| probe | exit | stderr | destination afterwards |
|---|---|---|---|
| `git index-pack --stdin --fix-thin` into an empty repository | 0 | empty | `.pack` / `.idx` / `.rev` created |
| the same command, byte-identical input, same repository | **0** | **empty** | all three unchanged — same inode, same fractional mtime, no temporary debris |
| the same again with `-v` | 0 | progress only, no "exists" message | unchanged |
| `fetch` with `fetch.unpackLimit=1`, local refs deleted so the server re-sends the same pack | 0 | normal `[new branch]` line | pack unchanged |
| `push` twice into a bare repository with `transfer.unpackLimit=1` | 0 / 0 | normal | pack unchanged |
| loose-object control: tamper a loose object to garbage, then re-write the identical content | 0 | empty | **the garbage is kept** — the already-present test is path existence, never content |
| `.idx` truncated to zero bytes, then re-index | 128 | `error: index file … is too small` | corrupt file left in place |

Canonical git's receive path is idempotent and silent; its only non-zero exits are
corrupt-store diagnoses, never a collision refusal.

**What tsgit does today**, diverging twice over. In
`src/application/primitives/fetch-pack.ts`, `materializePack` (lines 130–179) renames the
quarantined pack into place unconditionally — clobbering the destination `.pack` — and
`writePackSiblingArtifacts` then throws `FILE_EXISTS` on the first sibling. The stack is
`fetchPack → materializePack → writePackSiblingArtifacts → writeSiblingsGiven →
writeExclusive`, and the error is `TsgitError` with
`{ code: 'FILE_EXISTS', path: '<packDir>/pack-<sha>.idx' }`. `clone` and `fetch` do not
catch it; only `fetch-missing` does.

**The change.** When the content-addressed destination pack already exists, the receive
path discards its quarantine copy and returns the existing artefacts without renaming or
rewriting anything, and the check happens BEFORE the rename so nothing is clobbered.
Concretely, in `materializePack`, after the `entries.count === 0` guard and immediately
before the `try { await renamePackIntoPlace(...) }` block (decision candidate P2):

- Compute the destination with the already-imported `packFilePath(packDir, receipt.packSha)`.
- If `await ctx.fs.exists(<that path>)` is true: `await cleanupQuarantine(ctx, receipt.tmpPath)`
  (the quarantine copy is unlinked as a handled outcome — the existing temp-file posture is
  unchanged), refresh the pack registry (decision candidate P1), and return a
  `FetchPackResult` carrying the existing `packPath` and `idxPath`, `objectCount:
  entries.count`, `packSha: receipt.packSha`, and `download.shallow` / `download.unshallow`.

The existing-pack test is **by path**, matching git's own already-present test, which
keeps even a tampered file. Do not compare content; do not weaken `writeExclusive` on
either adapter — the exclusive write is the correct primitive, and the fix is a tolerant
caller.

Symbols and signatures in play:

- `src/application/primitives/fetch-pack.ts`
  - `const materializePack = async (ctx: Context, download: PackDownload, input: FetchPackInput): Promise<FetchPackResult>`
    — module-private, called only from `fetchPack`.
  - Local bindings it already has at the insertion point: `packDir` (from
    `packsDir(commonGitDir(ctx))`), `receipt` (`{ tmpPath, totalBytes, packSha }`),
    `entries` (from `indexQuarantinedPack`, carrying `count`).
  - Already imported: `packFilePath` and `writePackSiblingArtifacts` from
    `./internal/write-pack-artifacts.js`; `refreshPackRegistry` from `./read-object.js`;
    `cleanupQuarantine` is module-private in this same file (it wraps
    `removeQuarantineFileIfPresent` in `.catch(() => {})`).
  - `export interface FetchPackResult { readonly packPath: string; readonly idxPath: string; readonly objectCount: number; readonly packSha: string; readonly shallow: ReadonlyArray<ObjectId>; readonly unshallow: ReadonlyArray<ObjectId> }`.
- `src/application/primitives/internal/write-pack-artifacts.ts`
  - `export const packFilePath = (packDir: string, packSha: string): string => \`${packDir}/pack-${packSha}.pack\`` (line 140).
  - `const artifactPaths = (packDir: string, packSha: string): ArtifactPaths` (line 143)
    builds `idxPath` inline as `` `${packDir}/pack-${packSha}.idx` ``. There is no exported
    idx-path helper today. Add one — `packIdxFilePath(packDir, packSha)` — beside
    `packFilePath`, and have `artifactPaths` call it so there stays exactly one source for
    that name.
  - **Public-surface decision, made here: `packIdxFilePath` is INTERNAL.** The module sits
    under `src/application/primitives/internal/` and is imported only by
    `src/application/primitives/fetch-pack.ts`,
    `src/application/primitives/internal/cruft-pack-lifecycle.ts`,
    `src/application/commands/pack-objects.ts` and
    `src/application/commands/internal/gc-pipeline.ts`. It is in no barrel and reachable
    by no library user, so it trips **no** surface gate: no barrel entry, no facade
    binding, no `docs/use/commands/` page, no browser-surface scenario, no README count,
    and no `reports/api.json` regeneration. Do not regenerate api.json for this part.
  - Neither this file nor `fetch-pack.ts` carries a `@writes` JSDoc tag, so
    `check:write-surfaces` is unaffected by the change.
- `src/application/commands/fetch-missing.ts` — its `catch` around `fetchPack` swallows
  `FILE_EXISTS` (`const isFileExists = (err: unknown): boolean => err instanceof TsgitError && err.data.code === 'FILE_EXISTS'`,
  lines 78–79 and 121–126) with a comment stating exactly the right reason. That tolerance
  stays; only its test is repaired. This source file is NOT edited.

Coverage and mutation posture: `vitest.config.ts`'s coverage `include` does not list
`src/application/**`, so this file has no line-coverage gate; the mutation harness, which
mutates all of `src`, is run standalone on this diff by the orchestrator after the part
lands. Every test below is therefore written to kill a specific mutant class, one
condition per test, with error and value assertions specific enough that a string-literal
or conditional mutant cannot survive.

**Unit tests — `test/unit/application/primitives/fetch-pack.test.ts`** (5145 lines). Add
one new top-level describe at the end of the file; the file already carries several
non-GWT top-level wrappers (`describe('fetchPack')` at line 400,
`describe('pack quarantine')` at 2202, and so on), so a wrapper such as
`describe('fetchPack — an already-present pack')` is in keeping. Module-level helpers to
reuse, all already defined near the top of that file:

- `const ENCODER = new TextEncoder()` (line 96).
- `type MemCtx = ReturnType<typeof createMemoryContext>` (line 249).
- `const buildSingleBlobPack = async (ctx, content: string): Promise<{ packBytes: Uint8Array; blobId: ObjectId; idxBytes: Uint8Array }>` (line 387).
- `const buildUploadPackResponseBody = (opts: { packBytes; sideBand: boolean; progressLines? }): Uint8Array` (line 106).
- `const captureRequests = (body: Uint8Array): { transport: HttpTransport; requests: HttpRequest[] }` (line 165) — its `request` enqueues `body.slice()` on every call, so ONE transport serves two `fetchPack` calls.
- `const toNegotiator = (transport: HttpTransport): NegotiatePackBytes` (line 243).
- `const packDir = (ctx: MemCtx): string => \`${ctx.layout.gitDir}/objects/pack\`` (line 267).
- `const tmpPackNames = async (ctx: MemCtx): Promise<ReadonlyArray<string>>` (line 269) — the leftover-quarantine probe.

The pack sha for a built pack is `await ctx.hash.hashHex(packBytes.subarray(0, -20))`
(the trailer is the last `ctx.hash.digestLength` bytes; sha1 here), the same expression
`test/unit/application/commands/fetch-missing.test.ts` already uses. For the stale-registry
case, a second cache identity over the SAME filesystem is
`{ ...ctx, session: createSession() }` — `Session` is an opaque per-repository cache
anchor exported from `src/ports/context.ts` (`export function createSession(): Session`),
and every identity-keyed cache under `src/application/primitives` keys on it, so two
Contexts sharing an `fs` but not a `session` are two cache identities over one store.
`refreshPackRegistry(ctx)` (exported from `src/application/primitives/read-object.js`,
line 63) drops the registry cached for `ctx.session`.

**The fetch-missing tolerance repair — `test/unit/application/commands/fetch-missing.test.ts`**,
the case at lines 408–430: `describe('Given a concurrent identical pack already on disk')`
> `describe('When fetchMissing')` > `it('Then the FILE_EXISTS collision is tolerated')`.
It pre-creates only `${packDir}/pack-${packSha}.pack`, which `rename` then overwrites, so
the refusal it claims to exercise is never reached and its assertion cannot tell the two
outcomes apart. After this part it would additionally take the new already-present path
and never raise `FILE_EXISTS` at all. Repair it to pre-create the sibling the writer
actually collides on — `${packDir}/pack-${packSha}.idx` — and NOT the `.pack`: the rename
then succeeds, `writeSiblingsGiven`'s `writeExclusive` on the `.idx` refuses, and
`fetchMissing`'s tolerance is genuinely exercised. Keep the surrounding arrangement
(`seedRepo`, `withConfig(base, PARTIAL_CONFIG)`, `onePackedBlob`, `fakeRemote`) and the
`expect(result).toEqual({ remote: 'origin', requested: 1, fetched: 1 })` assertion;
rewrite the trailing comment so it describes what is actually pre-created.

**The interop test — new file `test/integration/pack-receive-idempotence-interop.test.ts`**
(decision candidate P5). Parity tests are cross-adapter and prove nothing about
faithfulness; only the interop harness does. Shape, following
`test/integration/index-pack-interop.test.ts`:

- A first-JSDoc `@proves` header is required by the integration-proof detector. Use
  `surface: fetchPack.receive` (unclaimed — the closest existing claims are `packIndex`
  and `fetch-pack.walkPackEntries`), `bucket: cross-tool-interop` (its directory rule
  allows only the mainline `test/integration/` directory, which is where this file goes),
  a `unique:` line between 12 and 200 characters — for example
  `re-receiving a byte-identical pack leaves the existing pack, idx and rev untouched, as git does`
  — and `interopSurface: packfile` for consistency with the file's siblings.
- Helpers from `./interop-helpers.js`: `GIT_AVAILABLE` (guard the suite with
  `describe.skipIf(!GIT_AVAILABLE)`), `makePeerPair(slug)` returning
  `{ peer, ours, dispose }` over two `mkdtemp` directories, `runGit(args, { input?, env? })`
  which spawns git with every `GIT_*` scrubbed, `HOME` pointed at a deterministic
  non-existent path, `GIT_CONFIG_NOSYSTEM=1` and auto-maintenance disabled on the env,
  `runGitEnv()` for a copy of that env, `disableAutoMaintenance(dir)`, and
  `tryRunGitWithExit(args, { env? })` returning `{ stdout, stderr, exitCode }`.
  `tryRunGitWithExit` has no `input` option today and this test needs one to feed pack
  bytes on stdin while capturing the exit code and stderr — extend it with an optional
  `input` exactly as `runGit` already declares one (`readonly input?: string | Uint8Array`,
  passed through to `spawnSync`'s opts). That is an additive helper change; do not alter
  its existing behaviour.
- ONE shared `beforeAll` fixture with a **60 000 ms timeout** (git-spawning interop
  suites have flaked on load without it): `makePeerPair('pack-receive-idempotence')`,
  `git init -q -b main` the peer, set `user.name` / `user.email` /
  `commit.gpgsign false`, `disableAutoMaintenance`, create three small commits, then
  `git -c pack.threads=1 repack -a -d`, then read the single surviving
  `objects/pack/*.pack` into a module-scoped `packBytes`. A git-produced pack is what
  makes the two tools comparable. `afterAll` disposes the pair.
- **tsgit row.** `git init -q -b main` a fresh `mkdtemp` directory, build a node context
  over it with `createNodeContext({ workDir: dir })`
  (`src/adapters/node/node-adapter.js`), and receive `packBytes` twice through
  `fetchPack(ctx, negotiator, { wants: ['a'.repeat(40) as ObjectId], haves: [], capabilities: [], progressOp: 'test:write-objects' })`
  with an inline `NegotiatePackBytes` that yields the bytes as one chunk from a fresh
  generator each call. Assert: the second call resolves; its `packPath`, `idxPath`,
  `packSha` and `objectCount` equal the first call's; the `.pack`, `.idx` and `.rev`
  bytes are byte-identical across the two calls; each file's `ino` and `mtimeMs` are
  unchanged; and no `tmp_pack_*` entry remains in the pack directory. This row is also
  the node adapter's coverage of the new path.
- **git row, same fixture.** `git init -q -b main` another fresh directory, run
  `git index-pack --stdin --fix-thin` with `packBytes` on stdin twice through the extended
  `tryRunGitWithExit`, and assert both `exitCode === 0`, both `stderr === ''`, and the
  three artefacts' bytes, `ino` and `mtimeMs` unchanged between the runs. This is the
  oracle the tsgit row is measured against, reproduced in the same fixture rather than
  quoted from a design table. The two tools are each compared against **themselves**
  across two runs, never against each other's file names — git and tsgit derive a pack's
  stem differently and no claim here depends on them agreeing.
- Each row creates its own destination directory with `mkdtemp` and removes it in a
  `finally` (or registers it for `afterAll`), so a failing assertion never leaves a repo
  behind in `os.tmpdir()`. `afterAll` also disposes the peer pair.

Test-convention constraints the audits gate on: `describe('Given …')` >
`describe('When …')` > `it('Then …')` (the two-level `Given …, When …` shortcut is
allowed when only one expectation lives under the When); AAA bodies with `// Arrange`,
`// Act`, `// Assert` section comments, none of them empty; the system under test bound
to `sut` and never to a result; at least one assertion per test; no `toThrow(SomeClass)`
without data assertions; no `vi.mock` / `vi.fn` / `vi.spyOn` in an integration test.

### TDD steps

Every RED below is a real failure against the current code, and each isolates one
condition so a mutant that flips only that condition dies.

1. **RED 1 — the divergence itself.** In `fetch-pack.test.ts`, add
   `Given a pack already received once into this repository` >
   `When fetchPack receives the byte-identical pack a second time` >
   `Then it succeeds and returns the artefacts already on disk`. Build a single-blob
   pack, receive it, then receive it again through the same transport. Assert the second
   result's `packPath`, `idxPath` and `packSha` equal the first's and `objectCount` equals
   the first's and is greater than zero. Expected failure: `TsgitError` with
   `data.code === 'FILE_EXISTS'` on `<packDir>/pack-<sha>.idx`.
2. **RED 2 — no clobber, checked before the rename.**
   `Given a pack file already occupying the content-addressed destination with foreign bytes` >
   `When fetchPack receives a pack whose trailer names that same destination` >
   `Then the file on disk still holds its original bytes`. Pre-create
   `<packDir>/pack-<sha>.pack` with a short sentinel byte string (NOT the real pack), then
   receive. Assert the returned `packPath` names that file, and that reading it back gives
   the sentinel bytes verbatim. Expected failure today: the rename clobbers the sentinel,
   then the `.idx` write throws. This is the test that pins the ordering — a fix placed
   after the rename passes RED 1 and fails this.
3. **RED 3 — the quarantine copy is discarded.**
   `Given a pack already received once into this repository` >
   `When fetchPack receives it a second time` > `Then no quarantine file is left behind`.
   Assert `tmpPackNames(ctx)` is empty after the second call. Kills the mutant that drops
   the cleanup call.
4. **RED 4 — the first receive still writes.**
   `Given an empty repository` > `When fetchPack receives a pack` >
   `Then the pack, its index and its reverse index are all written`. Assert all three
   paths exist and `objectCount` is the entry count. Kills the mutant that forces the new
   condition true and turns every receive into a no-op.
5. **RED 5 — the returned sibling path.** Inside RED 1, add one more assertion spelling
   the expected path out in full: `expect(second.idxPath).toBe(\`${packDir(ctx)}/pack-${packSha}.idx\`)`.
   It belongs in RED 1 rather than a test of its own — a separate case would repeat the
   whole two-receive arrangement to check one more string — and it is what kills a
   string-literal mutant inside the new path helper.
6. **RED 6 — shallow and unshallow still come from the download.**
   `Given a shallow response for a pack already on disk` >
   `Then the already-present result still carries the advertised shallow boundaries`. Use
   the file's existing `buildShallowResponseBody` helper and pass `depth` in the
   `FetchPackInput` so the negotiator actually consumes a shallow block. Kills the mutant
   that returns empty arrays on the new path.
7. **RED 7 — the stale registry (decision candidate P1(a)).**
   `Given a Context whose pack registry was cached before another writer landed the pack` >
   `When fetchPack receives that same pack through the stale Context` >
   `Then an object the pack carries is readable through it`. Arrange:
   `const ctx = createMemoryContext()`; warm `ctx`'s registry over the still-empty pack
   directory with `await getPackRegistry(ctx).lookup(<any oid>)` (`getPackRegistry` is
   exported from `src/application/primitives/read-object.js`), which forces the
   `objects/pack` scan and caches its empty result; land the pack through
   `{ ...ctx, session: createSession() }` — a second cache identity over the same `fs`,
   with `createSession` imported from `src/ports/context.js`; then receive through `ctx`
   and read the packed blob back with `readObject(ctx, blobId)`. Expected failure without
   the refresh: the read misses. If the warm step turns out not to cache (the registry
   scans lazily on a later call rather than on `lookup`), escalate
   `{ the registry refresh on the already-present path, cannot pin the observable without a mock, ≤3 options }`
   rather than shipping an unkillable line or reaching for `vi.spyOn`.
8. **RED 8 — the interop test, written before the fix so it is a real red.** Add the
   `input` option to `tryRunGitWithExit` in `test/integration/interop-helpers.ts`, then
   write `test/integration/pack-receive-idempotence-interop.test.ts` as described. Run it
   now: the git row passes on its own (it measures only git, and git is already
   idempotent), and the tsgit row fails on the second `fetchPack` with
   `TsgitError { code: 'FILE_EXISTS' }` on the `.idx`. That split — oracle green, tsgit
   red, one fixture — is the divergence stated in its most direct form.
9. **GREEN.** Add `packIdxFilePath` beside `packFilePath` in
   `internal/write-pack-artifacts.ts` and route `artifactPaths` through it. Add the
   already-present branch to `materializePack` at the position described above. Nothing
   else in either file changes. RED 1 through RED 8 all go green.
10. **The fetch-missing tolerance repair.** In `fetch-missing.test.ts`, change the
    pre-created file from the `.pack` to the `.idx` and re-run. This is a repair, not a
    red: the test passes both before and after the GREEN above (with no `.pack` in place
    the rename succeeds and the `.idx` write still refuses), so its value has to be
    demonstrated another way. Do that with a scratch experiment: temporarily replace
    `fetchMissing`'s `if (!isFileExists(err)) throw err;` with an unconditional rethrow
    and confirm the repaired test goes red where the old one stayed green. Restore the
    line immediately; do not commit the temporary edit.
11. **REFACTOR.** Update `materializePack`'s docstring: it now has three outcomes —
    suppress an empty pack, adopt an already-present one, or promote a new one — and the
    quarantine copy is unlinked as a handled outcome in the second, leaving the temp-file
    posture unchanged. Update `fetch-pack.ts`'s module doc where it says the quarantine
    file "is renamed to `pack-<sha>.pack`", which is now conditional. No provenance
    references in either comment.
12. Run the gate below, then confirm `git status --porcelain` lists exactly six files:
    the two under `src/`, the two amended unit tests, the new integration test, and
    `test/integration/interop-helpers.ts` for the `input` option.

### Gate

```bash
npx vitest run test/unit/application/primitives/fetch-pack.test.ts test/unit/application/commands/fetch-missing.test.ts test/integration/pack-receive-idempotence-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/fetch-pack.ts src/application/primitives/internal/write-pack-artifacts.ts test/unit/application/primitives/fetch-pack.test.ts test/unit/application/commands/fetch-missing.test.ts test/integration/pack-receive-idempotence-interop.test.ts test/integration/interop-helpers.ts \
  && npm run check:spelling
```

Then, because this part changes a receive path several commands share:

```bash
npm run check:test-pyramid   # GWT titles, AAA sections, sut naming, assertion counts — all gating
npm run check:architecture   # no new cross-layer import was introduced
```

The `@proves` header check itself is report-only in this repository's manifest, so a
malformed header will not fail the gate — write it correctly anyway, and read the audit's
report rather than trusting its exit code on that one heuristic.

### Commit

`fix(fetch-pack): tolerate an already-present pack before the rename, as git does`

## Part 6 — ADR status lines, anchors and citations satisfy the decision lint

### Context

Documentation only, seven files, no `src/` and no test delta.

The lint is `node /Users/scolladon/workspace/perso/craft/engine/bin/adr-lint.js docs/adr`,
run from the worktree root. It exits **2** today with eight findings plus one stderr
banner. Its rules, read from the engine source rather than inferred from the messages:

| check | rule | tolerance |
|---|---|---|
| status line | a line whose `trim()` **equals** `- **Status:** superseded by ADR-NNN` | nothing may follow `ADR-NNN`; surrounding whitespace is fine; several such lines may coexist, and extra non-matching bullets are permitted |
| supersession anchor | `/^Superseded from ADR-NNN\b/m` | must start the line; prose after the id is fine, bold wrapping or an indent is not |
| carry-forward anchor | `/^Carried forward from ADR-NNN\b/m` | same |
| citation sweep | one `git grep -E 'ADR-(<ids>)'` over the whole tracked tree | files under `docs/adr`, `docs/design`, `docs/plan`, `docs/archive` and `docs/prd` are skipped; every other match is reported |

Only a superseding ADR's YAML front-matter `supersedes:` block creates a supersession for
the lint. Exactly four ADRs declare one today: 718 over 389, 721 over 541, 731 over 724,
752 over 723. That count must stay at 4 — no front matter is edited by this part.

The eight findings, and the exact edit each takes:

1. **`docs/adr/389-incremental-stream-hash-verification.md`** — under its `## Status`
   heading the bullet reads
   `- **Status:** superseded by ADR-718 (default posture; the incremental mechanism stands)`.
   Trim it to the bare required form. Nothing is lost: the block quote under the title
   already says "for the default-on posture … the incremental end-of-stream verification
   mechanism and the `{ verifyHash }` option surface are carried forward". Leave the
   `## Status` heading and the outlier title alone.
2. **`docs/adr/541-raw-node-adapter-layout-root-set.md`** — the bullet reads
   `- **Status:** superseded by ADR-721 (read-path wrapper role for first-party adapters; root-set model stands)`.
   Trim it likewise. Its block quote already carries "for the facade wrapper's read-path
   role on first-party adapters … the adapter's root-set containment model,
   canonical-prefix derivation and write-path posture are carried forward unchanged".
3. **`docs/adr/724-maintenance-command-with-commit-graph-and-gc-lite.md`** — the
   multi-superseder. Today:
   `- **Status:** superseded by ADR-731 (prune semantics), ADR-732 (pack consolidation) and ADR-733 (promisor consolidation); the command and commit-graph task stand`.
   Replace it with the bare `- **Status:** superseded by ADR-731` **plus a separate
   non-status bullet directly below it** naming ADR-732 and ADR-733 with the scope each
   took over. Only ADR-731 declares the supersession in front matter, which is why the
   lint demands exactly one line; the other two supersessions stay visible at bullet
   level rather than being demoted to prose. Do not add `supersedes:` front matter to 732
   or 733 — that would change the declaring count and needs decision prose only the user
   can ratify.
4. **`docs/adr/721-first-party-read-containment-is-single-authority.md`**, lines 42–45 —
   `Carried forward from ADR-541:` exists but sits mid-line, after the
   `Superseded from ADR-541:` sentence. Re-wrap the paragraph so each anchor starts its
   own line at column zero, exactly as `docs/adr/718-read-path-hash-verification-is-opt-in.md`
   (its lines 45 and 48) already does. **The wording is unchanged** — only the line breaks
   move.
5. **`docs/adr/752-tree-read-paths-accept-duplicate-entry-names.md`**, lines 53 and 57 —
   both anchors are wrapped in bold markers (`**Superseded from ADR-723:**`,
   `**Carried forward from ADR-723:**`). Strip the `**` from both. The colon and
   the prose after it stay; the lint's word boundary permits them and
   `docs/adr/731-gc-uses-cruft-packs.md` (lines 41–42) writes them exactly that way.
6. **`docs/BACKLOG.md`**, the completed **30.3** entry at line 565 — it reads
   `(probed, git 2.55.0 — see ADR-723's addendum)`. ADR-752 explicitly carries that
   addendum forward, so the sentence is substantively true and only the identifier is
   stale. Re-point it at ADR-752 and name what it carried forward. The rest of the entry
   is unchanged. The trailing `· ADRs 748–766 ·` reference is not `ADR-NNN`-shaped and the
   sweep does not match it — leave it.
7. **`docs/understand/security.md`**, line 9 — the path-containment paragraph ends
   `… byte-identical to before ([ADR-541](../adr/541-raw-node-adapter-layout-root-set.md))`.
   ADR-721 superseded 541 on the facade wrapper's read-path role only and carried the
   root-set model forward unchanged; the same file's opening paragraph already describes
   ADR-721's ruling without citing it. Cite ADR-721 as the single authority for
   first-party read containment and say the root-set model is what it carried forward. The
   link target becomes `../adr/721-first-party-read-containment-is-single-authority.md` —
   that file exists, so `check:doc-links` stays green. No reference to 541 may survive in
   this file: the sweep matches the literal identifier anywhere in a tracked, non-exempt
   file, so "cite the superseding ADR and keep the old identifier" is not available.

Templates to copy from: `docs/adr/723-cursor-descent-keeps-the-duplicate-name-refusal.md`
is the status-line template — a bare `- **Status:** superseded by ADR-752` bullet with all
the scope nuance pushed up into the block quote under the title. ADRs 718 and 731 are the
anchor templates — column zero, no bold, `: ` then prose.

Out of scope, deliberately: wiring `adr-lint` into an npm script, a CI job or a hook. It
is invoked manually from the craft engine today; making it a gate is its own change with
its own waiver-file contract. No waiver file and no `--waiver-source` invocation exists in
this repository, and the waiver token covers a whole file rather than a line, so waiving
`docs/BACKLOG.md` is not on the table.

`docs/**/*.md` is inside `check:spelling`'s glob, so every edited sentence is spell-checked
by the part gate — but the lint-staged hook spell-checks nothing on a markdown-only
commit, so run the gate before committing, not after.

### TDD steps

There is no unit test for prose; the lint IS the test, and it is run before and after each
edit so every fix is a demonstrated red-to-green transition rather than an assumption.

1. **RED (baseline).** Run
   `node /Users/scolladon/workspace/perso/craft/engine/bin/adr-lint.js docs/adr; echo "EXIT=$?"`.
   Expected: `EXIT=2`, the stderr banner
   `adr-lint: citation sweep exempts (derived): docs/adr, docs/design, docs/plan, docs/archive, docs/prd`,
   and exactly these eight lines:
   - `docs/adr/389-…: missing required line: - **Status:** superseded by ADR-718`
   - `docs/adr/541-…: missing required line: - **Status:** superseded by ADR-721`
   - `docs/adr/721-…: missing a line starting "Carried forward from ADR-541"`
   - `docs/adr/724-…: missing required line: - **Status:** superseded by ADR-731`
   - `docs/adr/752-…: missing a line starting "Superseded from ADR-723"`
   - `docs/adr/752-…: missing a line starting "Carried forward from ADR-723"`
   - `DECISION-CITE-FOUND(docs/BACKLOG.md): ADR-723@L565`
   - `DECISION-CITE-FOUND(docs/understand/security.md): ADR-541@L9`
   Record the list; it is the checklist.
2. **GREEN, one file at a time**, re-running the lint after each so a fix that trips a new
   finding is caught at its own source: 389 → 541 → 724 (status line plus the extra
   bullet) → 721 (re-wrap) → 752 (strip the bold markers from both anchors) → `docs/BACKLOG.md` →
   `docs/understand/security.md`. Each step must remove exactly its own finding and add
   none.
3. **GREEN (final).** The lint prints the banner on stderr and exactly one stdout line,
   `craft-adr: OK — <N> ADR(s) checked, <M> declaring supersession.`, with `<M>` still
   **4**, and exits 0. A different `<M>` means front matter was edited — revert it.
4. **REFACTOR / read-back.** Re-read the three edited ADRs end to end and confirm every
   scope note the old status lines carried still exists somewhere in the same file
   (block quote for 389 and 541, the new bullet for 724). Confirm the two re-pointed
   citations still read as true sentences.
5. Confirm `git status --porcelain` lists exactly seven markdown files.

### Gate

```bash
npm run check:spelling \
  && node /Users/scolladon/workspace/perso/craft/engine/bin/adr-lint.js docs/adr
```

The lint must exit 0 and print nothing beyond the exempt-directories banner on stderr and
the single `craft-adr: OK` line on stdout. There is no vitest, types or biome step: this
part touches no `.ts` file and no configuration biome reads.

### Commit

`docs(adr): satisfy the decision lint on status lines, anchors and citations`

## Part 7 — dependency hygiene

### Context

House rule: every PR updates outdated dependencies, including out-of-scope ones. The gate
is `npm run check:deps`, whose command is

```
sh -c 'npm outdated || ! npm outdated 2>/dev/null | tail -n +2 | grep -v "^@ls-lint/ls-lint " | grep -v "^typescript " | grep -v "^knip " | grep -v "^jscpd " | grep -v "^vitest " | grep -v "^@vitest/coverage-v8 " | grep -v "^@cloudflare/workers-types " | grep -q .'
```

so seven packages are documented exceptions and everything else must be current:
`@ls-lint/ls-lint` (its publisher reports a false positive), `typescript` (7.x crashes
`@rollup/plugin-typescript`; pinned to 6.x), `knip`, `jscpd`, `vitest`,
`@vitest/coverage-v8` and `@cloudflare/workers-types`.

Measured in this worktree on 2026-09-05, `npm outdated` reported exactly six rows, every
one of them on that exception list:

| package | current | latest |
|---|---|---|
| `@ls-lint/ls-lint` | v2.3.1 | 2.3.1 |
| `@vitest/coverage-v8` | 4.1.11 | 5.0.0 |
| `jscpd` | 5.0.16 | 5.1.2 |
| `knip` | 6.33.0 | 6.34.0 |
| `typescript` | 6.0.3 | 7.0.2 |
| `vitest` | 4.1.11 | 5.0.0 |

So `check:deps` is green as this plan is written, and **this part may legitimately land no
commit**. That is the honest outcome, not a skipped step: the measurement is the
deliverable. Re-measure rather than trusting the table — the registry moves.

If something outside the exception list HAS drifted by the time this part runs, bump it
the way this repository does it: `npx npm@10 install --save-exact <pkg>@<latest>`. Never
`npm install` bare and never regenerate the whole lock file — a partial lock breaks CI
(npm version skew, and a macOS run drops the Linux-only optional binaries). If the lock
file ends up in a bad state, the recovery is to restore `main`'s `package-lock.json` and
re-run `npx npm@10 install --package-lock-only`.

Files that may change: `package.json` and `package-lock.json`, nothing else.

This part runs last so a bump lands on top of finished work and any breakage it causes is
attributable to the bump alone.

### TDD steps

1. **RED (measurement).** Run `npm outdated` and capture the table verbatim. Then run
   `npm run check:deps` and record its exit code. If the exit is 0 and every row is on the
   exception list, go to step 4.
2. **GREEN (only if a non-excepted package drifted).** For each such package run
   `npx npm@10 install --save-exact <pkg>@<latest>`, one package per command. Re-run
   `npm outdated` after each so a transitive change is attributed to the bump that caused
   it.
3. **REFACTOR / regression check.** Run `npm run check:types` and
   `npx vitest run --project unit` before anything else, then the part gate below. A major
   bump that reds a suite is escalated as `{ package, reason, ≤3 options }` — never
   pinned back silently and never suppressed.
4. **Record.** Whether or not a bump happened, the part reports the `npm outdated` table
   and `check:deps`'s exit code as its evidence. With no bump there is nothing to commit
   and the part lands no commit; say so plainly rather than manufacturing one.

### Gate

```bash
npm run check:deps \
  && npx vitest run --project unit \
  && npm run check:types \
  && ./node_modules/.bin/biome check package.json \
  && npm run check:spelling
```

`<touched-tests>` resolves to the whole `unit` project because a dependency bump is not
scoped to any file. If step 1 finds nothing to do, `npm run check:deps` alone is the
evidence and the rest of the gate is unnecessary — nothing changed.

### Commit

`chore(deps): bump outdated dependencies` — landed **only** if step 2 actually bumped
something. No bump, no commit.

## After part 7 — the phase gate

```bash
npm run validate
```

Ground truth for the whole change. If it times out on tests outside the diff, that is
oversubscription: re-run with `WIREIT_PARALLEL=1`. Never `--no-verify`. A green wireit
run can be cached from an earlier invocation — before pushing, re-run `cspell` fresh over
the touched documentation and confirm `reports/api.json` needs no regeneration (this
change adds no public export, so it should not).
