# Design — the benchmark snapshot publishes again, the bench summary renders tsgit-only scenarios, `adr-lint` runs clean

> Brief: one chore PR carrying three pre-existing items — part C, the fetch-pack bench never
> measures and the bench harness hides the failure, which reds `main` at the publish step;
> part A, `tooling/bench-summarize.ts` blanks every tsgit-only scenario; part B, eight
> `adr-lint` findings. All three ship together; there are no follow-ups.
> Status: draft → self-reviewed ×3

## Context

### Part C — the failure chain, pinned end to end

Three defects stack. Only the first is a bug in the bench; the second is a hole in the
harness; the third is a converter that trusts its input.

**C-i. The scenario throws on its second iteration.** `test/bench/fetch-pack.bench.ts`
creates one memory context in the scenario's `build` callback and measures `fetchPack` into
**that same context** on every iteration. Probed here: one receive of the scenario's pack
leaves exactly three files in `/repo/.git/objects/pack` —
`pack-<sha>.pack`, `pack-<sha>.idx`, `pack-<sha>.rev` — and nothing else anywhere under
`/repo/.git` except the `objects` directory itself. The second call renames its quarantined
pack over the existing `.pack` and then throws on the first exclusive sibling write. The
stack is `fetchPack → materializePack → writePackSiblingArtifacts → writeSiblingsGiven →
MemoryFileSystem.writeExclusive`, and the error is
`TsgitError FILE_EXISTS` with `{ code: 'FILE_EXISTS', path: '/repo/.git/objects/pack/pack-<sha>.idx' }`.
Removing only the `.pack` and `.idx` before re-entering moves the throw one artefact along,
to `pack-<sha>.rev` (probed) — the sibling set is a moving target, which matters for the
shape decision below.

**C-ii. The harness reports the throw as a pass.** Pinned against the installed
`vitest@4.1.11` and `tinybench@2.9.0`, in a throwaway project outside the worktree:

| probe | bench options | exit | terminal | `raw.json` entry |
|---|---|---|---|---|
| scenario throws from call 2, healthy sibling scenario after it | none (today) | **0** | the throwing scenario prints no row at all, only a Summary line; the sibling prints a normal table | `{ id, name, rank, rme: 0, samples: [] }` — no `mean`, no `median`, no `hz`, no `sampleCount` |
| same, error raised during warmup | `throws: true` | **1** | `FAIL <file> [ <file> ]` with the real message and a tinybench stack through `warmup` | file written; only the failing group present |
| error raised after warmup, in the measured run | `throws: true` | **never exits** | nothing after the RUN banner | no file written |

The mechanism: `bench(name, fn, options)` stores the options object verbatim, and vitest's
benchmark runner passes it straight to `new Bench(...)`, which reads `throws` off it — so
`throws` is a real, forwarded knob (verified, not assumed). Without it, tinybench's `warmup`
stores the error on the task and returns; `run` then returns early on that stored error
**before** dispatching either the `complete` or the `error` event, and vitest listens for
nothing else. The task keeps the placeholder result the runner built for it
(`{ name, rank: 0, rme: 0, samples: [] }`), the suite is marked `pass`, and the process exits
0. That placeholder is byte-for-byte the shape observed in both nightly artifacts and in a
local run of the real file.

The third row is the cost of the fix and must be designed around: the runner awaits
`task.run()` inside a `setTimeout` callback and resolves an outer promise with its result, so
a rejection there never resolves that promise and the run deadlocks. A **warmup** failure is
raised from a directly awaited call and fails cleanly; a **run-phase** failure hangs. No CI
job in `.github/workflows/ci.yml` sets `timeout-minutes`, so a hang there runs to GitHub's
360-minute default. `bench.yml` already caps its job at 30 minutes.

Second consequence of `throws: true`, also pinned: the raised error aborts the whole file —
the healthy sibling scenario declared after the failing one never ran. And tinybench fires
the bench-level teardown hook with mode `warmup` before raising, which the DSL's
`onMeasuredRun` deliberately ignores, so a copy-based scenario's scratch directory is left
behind. That is already the documented contract in `test/bench/support/bench-dsl.ts`, and
`bench:fixture -- --prune` is the reclaimer.

**C-iii. The converter emits an entry with no `value`.** `toSnapshotEntries` in
`tooling/bench-to-snapshot.ts` maps every benchmark to `{ name, unit, value: median ?? mean }`.
Its `RawBenchmark` interface declares `mean: number` as required and `median?: number` as
optional — for the entry above **both are absent at runtime**, so the declared type is a lie
and `value` silently becomes `undefined`, which `JSON.stringify` drops. The published file
therefore carries an entry with no `value` key, and
`benchmark-action/github-action-benchmark@v1` refuses it.

### Part A — the summary blanks 81 of 95 scenarios

`renderRow` in `tooling/bench-summarize.ts` requires **both** a `tsgit` and an
`isomorphic-git` entry in a group and otherwise emits
`| <scenario> | _missing entry_ | _missing entry_ | n/a |`. Rendering the real nightly
artifact through the current script here produced **95 data rows, 81 of them blank** — the
suite has 14 paired groups and 81 tsgit-only groups (109 entries over 30 files), and no group
without a `tsgit` entry at all. A reader of `summary.md` sees 85% of the suite reported as
not run.

Today's paired row, rendered from that artifact:

```
| Given a delta-chain repo (300 commits, deep delta chains), When readBlob() reads a deep-chain leaf from a cold pack, Then compare tsgit against isomorphic-git | 3.698 ms (256/s, ±5.26%) | 1.233 ms (529/s, ±13.78%) | 0.33× |
```

Today's blank row, same artifact:

```
| Given a 64 KiB highly compressible zlib member, When the bundled decoder (inflateZlibMember) decodes it, Then measure tsgit | _missing entry_ | _missing entry_ | n/a |
```

Two mechanical facts about the file itself. It exports nothing and calls `main()` at import,
so no part of it is reachable from a test. And `tooling/bench-summarize.ts` is **not** in
`biome.json`'s `files.includes` whitelist, so it is silently unlinted — verified by running
`biome check` against it, which reports the path as ignored. Its content is nevertheless
already clean under the repository's own rule set (verified by running the same configuration
over a copy in a throwaway directory: zero findings, zero formatting diff), so adding it to
the whitelist costs nothing.

### Part B — what `adr-lint` actually checks

`node <craft-engine>/bin/adr-lint.js docs/adr`, run from the worktree root, exits **2** and
prints the eight findings quoted in the brief, plus one stderr banner:
`adr-lint: citation sweep exempts (derived): docs/adr, docs/design, docs/plan, docs/archive, docs/prd`.
A clean run prints that banner plus a stdout line of the form
`craft-adr: OK — <N> ADR(s) checked, <M> declaring supersession.`

The rules, read from the engine source rather than inferred from the messages:

| check | rule | tolerance |
|---|---|---|
| status line | a line whose `trim()` **equals** `- **Status:** superseded by ADR-NNN` | nothing may follow `ADR-NNN`; surrounding whitespace is fine; several such lines may coexist |
| supersession anchor | `/^Superseded from ADR-NNN\b/m` | must start the line; prose after the id is fine, bold wrapping or an indent is not |
| carry-forward anchor | `/^Carried forward from ADR-NNN\b/m` | same |
| citation sweep | one `git grep -E 'ADR-(<ids>)'` over the whole tracked tree | files under the exempt directories are skipped; otherwise every match is reported |

The **only** thing that creates a supersession for the lint is the superseding ADR's YAML
front-matter `supersedes:` block (`adr` a quoted three-digit string, `scope` a non-empty
string). Status lines and prose anchors are consequences it then demands; they never create
one. Exactly four ADRs declare supersession today: 718 → 389, 721 → 541, 731 → 724,
752 → 723. A missing front-matter block is never a finding, which is what keeps the other
805 files green.

The eight findings are therefore five formatting defects and two live citations:

- **389, 541, 724** — the status line exists but carries a trailing parenthetical scope; 724
  additionally names three superseding ADRs on one line. The scope wording must survive the
  fix.
- **721** — `Carried forward from ADR-541:` exists but sits mid-line, after the
  `Superseded from` sentence.
- **752** — both anchors exist but are bold-wrapped (`**Superseded from ADR-723:**`).
- **`docs/BACKLOG.md`** — the completed 30.3 entry says `(probed, git 2.55.0 — see
  ADR-723's addendum)`. ADR-752 explicitly carries that addendum forward, so the sentence is
  substantively true; only the identifier is stale.
- **`docs/understand/security.md`** — the path-containment paragraph cites `[ADR-541]` for
  the root-set model. ADR-721 superseded 541 on the facade wrapper's read-path role only and
  carried the root-set model forward unchanged; the same file's opening paragraph already
  describes ADR-721's ruling without citing it.

ADR-723 is the one file whose superseded status line already passes, and it is the template:
a bare `- **Status:** superseded by ADR-752` bullet with all the scope nuance pushed up into
the block quote under the title. ADRs 718 and 731 are the templates for the anchors —
column-zero, no bold, `: ` then prose.

Two properties of the waiver route matter for the decision. `DECISION-CITE-WAIVE(<file>)`
waives a **whole file**, not a line, so waiving `docs/BACKLOG.md` would also silence every
future stale citation in it. And the token is read only from files named by a repeatable
`--waiver-source` flag; no waiver file exists in this repository, and nothing here invokes
`adr-lint` at all (no npm script, no CI job, no hook), so the waiver route means authoring
a new file *and* a new invocation contract.

### The pin that overturns the brief's premise

The brief asserts that the `FILE_EXISTS` refusal is correct because "git's `index-pack`
refuses to clobber too". Pinned against `git version 2.55.0` in a `mktemp` throwaway with all
`GIT_*` scrubbed, an isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1` and signing off, that is
**false**:

| probe | exit | stderr | destination afterwards |
|---|---|---|---|
| `git index-pack --stdin --fix-thin` into an empty repository | 0 | empty | `.pack` / `.idx` / `.rev` created |
| the **same** command, byte-identical input, same repository | **0** | **empty** | all three unchanged — same inode, same fractional mtime; no temporary debris |
| the same again with `-v` | 0 | progress only — no warning, no "exists" message | unchanged |
| `fetch` with `fetch.unpackLimit=1`, local refs deleted so the server re-sends the same pack | 0 | normal `[new branch]` line | pack unchanged |
| `push` twice into a bare repository with `transfer.unpackLimit=1` | 0 / 0 | normal | pack unchanged |
| loose-object control: tamper a loose object to garbage, then re-write the identical content | 0 | empty | **the garbage is kept** — the already-present test is path existence, never content |
| `.idx` truncated to zero bytes, then re-index | 128 | `error: index file … is too small` | corrupt file left in place; temporary files left behind |
| `.pack` replaced by non-pack bytes, then re-index | 128 | `error: file … is not a GIT packfile` | same |

Canonical git's receive path is idempotent and silent. Its only non-zero exits are
corrupt-store diagnoses, never a collision refusal.

tsgit diverges twice over. `materializePack` in `src/application/primitives/fetch-pack.ts`
renames the quarantined pack into place unconditionally — so the destination `.pack` is
**clobbered** — and then `writePackSiblingArtifacts` throws `FILE_EXISTS` on the first
sibling. `clone` and `fetch` do not catch it; only `fetch-missing` does, with a comment
stating exactly the right reason ("packs are content-addressed, so any `FILE_EXISTS` means a
concurrent fetch already landed byte-identical artifacts"). The one existing test for that
tolerance pre-creates only the `.pack`, which `rename` then overwrites, so the refusal it
claims to exercise is never reached and its assertion cannot tell the two outcomes apart.
ADR-728 pinned the quarantine lifecycle but explicitly did not pin the already-present
destination; ADRs 779 and 787 do not touch it. No ADR sanctions the divergence, and there is
no interop test covering a second receive of the same pack.

Under the prime directive this is a real defect, not a bench artefact — hence decision
candidate **D5**. It does **not** block part C: even with a tolerant receive path, a second
iteration into an occupied destination would skip the sibling writes and price a different
path, so the bench needs a fresh destination under every outcome of D5.

### Constraining decisions

- **ADR-226** — replicate git's observable behaviour unless an ADR diverges and says why.
- **ADR-056** — the snapshot metric is `median ?? mean` in milliseconds under
  `customSmallerIsBetter`, keyed `"<group fullName> > <bench name>"`, and the converter
  deliberately keeps **its own** minimal view of the vitest schema rather than sharing types
  with `bench-summarize.ts`. Both survive this change.
- **ADR-480** — the runnable bench set stays at exactly two names, so the two-name keying in
  `bench-dsl.ts` and `bench-summarize.ts` needs no change and no N-competitor renderer ships.
  Part A fixes rendering **inside** that constraint.
- **ADR-488 / ADR-651** — `benchmark-compare` is label-gated and `continue-on-error`, so a
  refusal reaching `tooling/bench-check.ts` (which imports `toSnapshotEntries`) can never
  block a merge. Relevant to D3.
- **ADR-791 / ADR-799** — bench scratch copies live in `fixture-scratch.ts` and leftovers are
  reclaimed only by an explicit `--prune`. A scenario that dies in warmup skipping its
  teardown is the already-accepted cost of that posture.
- **ADR-642** — the snapshot job stays per-merge on `main`.

## Requirements

R1. `npx vitest bench --run --config vitest.bench.config.ts test/bench/fetch-pack.bench.ts`
    produces a `tsgit` entry with a `sampleCount` above zero and a numeric `median`.

R2. The fetch-pack scenario's describe title is byte-identical to today's — it is the
    published series key.

R3. Every measured iteration of that scenario pays the full receive-and-index cost: quarantine
    write, trailer verification, both index passes, and the `.pack`/`.idx`/`.rev` writes. No
    part of that cost moves outside the measured function, and pack construction stays outside
    it.

R4. A benchmark whose measured function throws during warmup makes `vitest bench` exit
    non-zero with the error visible, in every bench file, without any per-file opt-in.

R5. `tooling/bench-to-snapshot.ts` refuses, by name, any benchmark that yields no numeric
    value, and never writes `reports/benchmarks/snapshot.json` when one is present. The
    refusal message names the scenario and the benchmark.

R6. `RawBenchmark`'s declared shape matches what vitest actually emits: both `mean` and
    `median` are optional.

R7. A tsgit-only group renders its tsgit cell exactly as a paired row renders it
    (median-else-mean in ms, hz, rme), an unambiguously empty baseline cell, and `n/a` in the
    speedup column. Paired rows are byte-identical to today's output.

R8. A group with no `tsgit` entry keeps an explicit "missing" rendering — that is the real
    anomaly and must stay visible.

R9. The table footnote says that the speedup column applies to paired rows only.

R10. The row renderer and the document renderer are pure, exported, and unit-tested;
     `main()` runs only when the module is invoked directly; `npm run bench:summary`
     behaviour is otherwise unchanged.

R11. Every `tooling/` file this change adds or edits, and the new unit test, are listed in
     `biome.json`'s `files.includes` — the whitelist is opt-in, so an unlisted file is
     silently unlinted.

R12. `node <craft-engine>/bin/adr-lint.js docs/adr` exits 0 and prints only the exempt-set
     banner and the `craft-adr: OK` line. Every scope note the current status lines carry
     survives somewhere in the same ADR.

R13. `npm run validate` is green, and `npm outdated` minus the documented exceptions is
     clean.

R14. `npm run bench:summary` completes on the **current** nightly artefact — the one holding a
     benchmark with no samples — whichever order the parts land in. No input the raw schema
     can produce makes a renderer throw.

R15. Conditional on D5 landing on (b) or (c): re-receiving a byte-identical pack through
     `fetchPack` succeeds, leaves the existing artefacts in place, and is pinned by a
     cross-tool interop test against real `git` rather than by a same-adapter parity test.

R1–R14 hold under every outcome of every candidate; only R15 is conditional.

## Design

### Files and symbols this touches

Part C:

- `test/bench/fetch-pack.bench.ts` — the whole file. `buildChainedEntries(): EntrySpec[]`,
  `toNegotiator(packBytes: Uint8Array): NegotiatePackBytes`, and the
  `benchScenario(given, whenThen, build)` call whose `build` closes over `ctx`, `built` and
  `negotiator` and returns `{ sut }` where `sut: () => Promise<void>`. Constants
  `CHAIN_DEPTH = 200`, `CHAIN_COUNT = 8` are unchanged.
- `test/bench/support/bench-dsl.ts` — `hooksFor(comparison: BenchComparison): ScenarioHooks`
  (early-returns `{}` when `comparison.teardown === undefined`),
  `interface MeasuredRunHooks extends BenchOptions` (its `teardown` is **required** today),
  `afterMeasuredRun(teardown: Teardown): MeasuredRunHooks`,
  `onMeasuredRun(teardown)(mode: HookMode)`, `interface ScenarioHooks { tsgit?, baseline? }`,
  and `benchScenario(given, whenThen, build, opts)` which calls
  `bench('tsgit', comparison.sut, hooks.tsgit)`.
- `tooling/bench-to-snapshot.ts` — `interface RawBenchmark { readonly name: string; readonly
  mean: number; readonly median?: number }`, `toSnapshotEntries(raw: RawReport):
  SnapshotEntry[]`, `withNodeVersion(entries, resolvedNodeVersion)`,
  `resolveNodeVersion(env)`, `main()`, `invokedDirectly()`.
- `.github/workflows/ci.yml` — the `benchmark-snapshot` job (no `timeout-minutes` today, on
  any job in the file).
- Fixture reused as-is: `buildSyntheticPack(ctx, entries)` and `EntrySpec` from
  `test/unit/application/primitives/pack-fixture.ts`.

Part A:

- `tooling/bench-summarize.ts` — interfaces `BenchEntry`, `BenchGroup`, `BenchFile`,
  `RawReport`; helpers `scenarioName(fullName)`, `findByName(group, name)`,
  `formatMs(value)`, `formatHz(value)`, `formatSpeedup(a, b)`; `renderRow(group: BenchGroup):
  string`; `main()` — currently invoked unguarded at import. Nothing is exported today.
- `biome.json` — the `files.includes` array.
- `tooling/test/unit/bench-summarize.test.ts` — new. `vitest.config.ts`'s `unit` project
  already globs `tooling/test/unit/**/*.test.ts`, so no config change. Mirror
  `tooling/test/unit/bench-to-snapshot.test.ts` (imports its subject as `../../bench-to-snapshot.js`)
  and `tooling/test/unit/gen-bench-fixture.test.ts` (imports as `../../gen-bench-fixture.ts`);
  either specifier resolves, since `bench-summarize.ts` has no relative imports of its own for
  `node --experimental-strip-types` to resolve.

Part B — seven files, all under `docs/`:

- `docs/adr/389-incremental-stream-hash-verification.md`
- `docs/adr/541-raw-node-adapter-layout-root-set.md`
- `docs/adr/721-first-party-read-containment-is-single-authority.md`
- `docs/adr/724-maintenance-command-with-commit-graph-and-gc-lite.md`
- `docs/adr/752-tree-read-paths-accept-duplicate-entry-names.md`
- `docs/BACKLOG.md` (the completed 30.3 entry)
- `docs/understand/security.md` (the path-containment paragraph)

Under D6(b) two more: `docs/adr/732-gc-consolidates-existing-packs.md` and
`docs/adr/733-gc-repacks-promisor-objects-separately.md`. The already-conforming templates to
copy from are `docs/adr/723-cursor-descent-keeps-the-duplicate-name-refusal.md` (status line),
`docs/adr/718-read-path-hash-verification-is-opt-in.md` and
`docs/adr/731-gc-uses-cruft-packs.md` (both anchors).

### Part C1 — the fetch-pack scenario receives into a fresh destination

`buildSyntheticPack` reaches the context only through `ctx.compressor.deflate` and
`ctx.hash.hashHex`; it writes nothing. The produced pack bytes therefore depend on the hash
algorithm, not on the store, and can be built **once** in `build` and replayed into any
number of destinations. So the whole change is which context `sut` receives into:

- `build` keeps: one seed context used solely to construct the pack, the entry list, the
  built pack, the negotiator closure and the wanted id.
- `sut` becomes `fetchPack(createMemoryContext(), negotiator, { … })` — a fresh, empty
  destination per iteration, with the unchanged `packPath === ''` guard.
- The comment claiming the packs "land in the memory adapter's own store; it dies with the
  worker" is replaced: each iteration's store is unreachable once the iteration ends, so the
  scenario no longer accumulates.

Measured here on the same machine, in the isolated probe project:

| shape | result |
|---|---|
| today (one shared context) | throws on iteration 2; zero samples |
| fresh context per call | **measures**: mean 35.09 ms / median 35.23 ms / 28.50 hz / ±0.78% over 15 samples; a second run of the same shape gave mean 31.27 ms / ±2.39% over 17 samples |
| context construction alone | mean 0.0011 ms — about 0.003% of one iteration |
| shared context, `.pack` + `.idx` removed after each call | throws `FILE_EXISTS` on `pack-<sha>.rev` |

The fixture is 1608 entries over 247,544 pack bytes (eight chains, 200 deep).

Three properties settle the shape (see D4). Context construction is three orders of magnitude
below the measured cost, so it does not distort the series. A fresh context means a **cold**
delta cache on every iteration, which is what a real receive faces; a shared context would
serve iterations 2..n from a warm cache and price something the scenario does not claim to
measure. And the removal shape has to enumerate every artefact the writer emits — a list that
grew by `.rev` one phase ago and will grow again — whereas a fresh destination is immune to
that coupling by construction.

### Part C2 — the DSL turns a silent warmup failure into a red run

`hooksFor` in `test/bench/support/bench-dsl.ts` currently returns `{}` when a comparison
declares no teardown, and `benchScenario` then calls `bench(name, fn)` with no options at all.
Every bench must instead receive an options object carrying `throws: true`, whether or not it
also carries a teardown:

- `MeasuredRunHooks` (whose `teardown` is required today) splits: an options type that always
  carries `throws: true` and optionally the teardown hook. The teardown routing is unchanged —
  the hook still rides the scenario's **last** bench so a baseline still measures on an intact
  scratch copy, and `onMeasuredRun` still ignores the `warmup` mode.
- `hooksFor` loses its early return: with no teardown it returns throwing options for both
  benches; with one, it returns throwing options for both and attaches the teardown to the
  last.
- `benchScenario` always passes the resolved options to `bench(...)`.

The blast radius is deliberate and file-wide: a scenario that dies in warmup aborts the rest
of its file. That is the correct trade — a bench file that cannot measure one scenario has
already lost the run's meaning for that file, and the alternative is today's silent pass. The
per-file abort is recorded here so a future reader does not mistake a truncated `raw.json` for
a second defect.

Applying `throws: true` to all 30 bench files could in principle red a *different* scenario
that has also been failing silently. The current nightly artefact settles the exposure
empirically: of 109 entries, **exactly one** has no samples — the fetch-pack scenario this PR
fixes. So the sweep is expected to go green on the C1 fix alone. If it does not, the newly
surfaced scenario rides in this PR (there are no follow-ups); if its fix is not small, it is
escalated as `{ scenario, reason, ≤3 options }` rather than suppressed.

The run-phase deadlock pinned above is the residual risk. It cannot be removed while `throws`
is set, only bounded — D2 recommends a `timeout-minutes` cap on `benchmark-snapshot` matching
`bench.yml`'s existing 30, so the worst case is a bounded red rather than a six-hour one.

One existing contract becomes load-bearing in a new way: tinybench invokes the teardown hook
without awaiting it and inside `run`'s own body, so a teardown that throws lands in the same
never-resolving promise. `fixture-scratch.ts`'s `removeSync` already swallows and logs for
this reason; under `throws: true` that swallow stops being defensive and starts being what
keeps a cleanup failure from hanging the runner. No change is needed — the invariant is
recorded so nobody "tidies" it into a rethrow.

### Part C3 — the converter refuses an entry it cannot value

Two changes in `tooling/bench-to-snapshot.ts`:

- `RawBenchmark.mean` becomes optional, matching reality. `toSnapshotEntries` keeps its
  `median ?? mean` metric and its `"<group> > <bench>"` naming exactly as ADR-056 fixed them.
- A new exported, pure guard walks the parsed report and throws when any benchmark yields
  neither `median` nor `mean`, naming every offender as `"<group fullName> > <bench name>"`.
  `main()` calls it before converting, so the refusal happens before `snapshot.json` is
  written and the publish step never sees a partial file.

Placing the guard beside `toSnapshotEntries` rather than inside it (D3) keeps
`tooling/bench-check.ts`, the only other consumer, free to decide its own policy: it already
models a `missing` verdict for absent scenarios, and it runs behind a label on a
`continue-on-error` job where a hard throw is noise rather than signal.

### Part C4 — the fixture cache side effect, recorded not fixed

`actions/cache`'s post step is `post-if: success()`, so the red job saved no `main` cache
entry for the current fixture key. The first green `main` run after this merge rebuilds the
scaled fixtures once — roughly ten minutes — and saves the entry. No change is made for this;
it is self-healing and recorded so the slow run is not read as a regression.

### Part A — `bench-summarize.ts` renders a tsgit-only row

The renderer gains one branch and loses its all-or-nothing guard:

| group shape | tsgit cell | baseline cell | speedup |
|---|---|---|---|
| paired | `<median-else-mean> ms (<hz>/s, ±<rme>%)` | same, from the `isomorphic-git` entry | `<iso/tsgit>×`, or `n/a` when the tsgit value is zero |
| tsgit only (81 of 95 today) | as above | an unambiguously empty marker | `n/a` |
| no tsgit entry, or a tsgit entry with no measurement | `_missing entry_` | `_missing entry_` | `n/a` |

**The renderer must be total, and that is not optional.** Today's all-or-nothing guard
accidentally protects the formatters: the one entry in the suite with no samples sits in a
tsgit-only group, which takes the `_missing entry_` branch and never reaches `formatMs`. The
moment a tsgit-only group formats its own cell, that same entry would reach
`formatMs(undefined)` and crash `npm run bench:summary` on the very artefact this part is meant
to fix. `BenchEntry` therefore gets the same reality check the converter's `RawBenchmark` gets
— `mean` and `hz` become optional, `median` already is — and one predicate decides the cell:
an entry counts as measured when `median ?? mean` and `hz` are both numbers, and renders as
missing otherwise. vitest emits those fields together (a task carries either a full result or
the `{ id, name, rank, rme, samples }` placeholder), so the two conditions never disagree in
practice; the predicate is what makes that a checked fact rather than an assumption.

The anomaly branch is uniform on purpose: **any** group that cannot produce a tsgit
measurement renders both cells as `_missing entry_`, whatever the baseline holds. That row is
an alarm, not a comparison — a lone baseline number beside a blank tsgit cell invites exactly
the misreading the alarm exists to prevent — and it keeps today's bytes for the one shape that
is genuinely broken.

This also decouples the commits: part A is safe to land before or after part C, on today's
artefact, in either order.

Paired rows keep their exact current bytes: the same `toFixed` precisions, the same `ms`,
`/s` and `±%` decorations, the same `×` suffix on the speedup, the same column order. The footnote gains one clause saying the
speedup column applies to paired rows only. The two-name keying (`findByName(group, 'tsgit')`
and `findByName(group, 'isomorphic-git')`) is untouched, as ADR-480 requires.

For testability the file keeps its own schema view (ADR-056) and mirrors
`bench-to-snapshot.ts`'s shape rather than growing a second module (D9):

- `renderRow(group)` becomes exported and pure — it already is pure.
- A new exported `renderSummary(raw, environment)` builds the whole document. The three
  impure inputs the current `main` inlines — the timestamp, the platform/arch/Node triple and
  the CPU model — move into an `environment` parameter, so the document is deterministic under
  test. `main()` is the only place that reads the clock, `process` and `os`.
- `main()` is guarded by the same `invokedDirectly()` predicate `bench-to-snapshot.ts` and
  `gen-bench-fixture.ts` use — resolve `process.argv[1]` and compare it to
  `fileURLToPath(import.meta.url)` — so importing the module runs nothing.
- `biome.json`'s `files.includes` gains `tooling/bench-summarize.ts` and
  `tooling/test/unit/bench-summarize.test.ts`. The existing file is already clean under those
  rules, so the whitelist entry is free.

Nothing about `npm run bench:summary` changes: the same wireit script, the same input and
output paths, the same "Wrote …" line.

### Part B — the eight findings

**Status lines (389, 541, 724).** Each becomes the bare form the lint requires, with the
scope wording moved into the block quote under the title — the shape ADR-723 already uses.

- **389** keeps its `## Status` heading and outlier title; only the bullet is trimmed to
  `- **Status:** superseded by ADR-718`. Its block quote already says "for the default-on
  posture … the incremental end-of-stream verification mechanism and the `{ verifyHash }`
  option surface are carried forward", which is the whole of the parenthetical being removed,
  so nothing is lost and nothing needs writing.
- **541** likewise trims to `- **Status:** superseded by ADR-721`. Its block quote already
  carries "for the facade wrapper's read-path role on first-party adapters … the adapter's
  root-set containment model, canonical-prefix derivation and write-path posture are carried
  forward unchanged".
- **724** is the multi-superseding case and is D6. Its block quote already names all three
  superseding ADRs with per-ADR scope; only the bullet form is in question.

**Anchors (721, 752).** Purely positional.

- **721**: `Carried forward from ADR-541:` moves to the start of its own line. The sentence
  is re-wrapped so the paragraph still reads as prose; the wording is unchanged.
- **752**: the `**` wrappers come off both `Superseded from ADR-723:` and
  `Carried forward from ADR-723:`. The colon and the prose after it stay — the lint's word
  boundary permits them, and ADRs 718 and 731 write them exactly that way.

**Citations.** Both are D7 and D8. Note that the sweep matches the literal `ADR-NNN`
anywhere in a tracked, non-exempt file, so "cite the superseding ADR **and** keep the old
identifier" is not available without a whole-file waiver.

**Verification.** The lint is re-run from the worktree root after the edits and must print
only the banner and the `craft-adr: OK` line. Because it is not wired into any npm script,
CI job or hook in this repository, this is a manual step in the run record — wiring it is
not in scope.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Where the zero-sample guard lives | (a) DSL `throws: true` only; (b) converter refusal only; (c) both | **(c)** | They close different holes. The DSL makes the bench step itself red at the source, with the stack — the only signal that names the defective scenario. The converter refusal is the invariant on the published artefact: whatever future path produces an entry with no value, it never reaches the action. (a) alone leaves the publish step trusting its input; (b) alone leaves a bench file passing green while measuring nothing. |
| D2 | Bounding the pinned run-phase deadlock that `throws: true` introduces | (a) accept the deadlock and add `timeout-minutes` to `benchmark-snapshot` (matching `bench.yml`'s 30); (b) accept it unbounded — no CI job here sets a timeout today; (c) drop `throws` to avoid it entirely | **(a)** | The failure mode is real and pinned: a rejection inside the runner's `setTimeout` callback never resolves its promise. Unbounded, that burns GitHub's 360-minute default. A timeout is one line, converts a hang into a bounded red, and is a strict improvement for every other job-level failure too. (c) trades a bounded hang for a silent pass — the defect we are here to fix. |
| D3 | Where the converter's refusal sits | (a) inside `toSnapshotEntries`; (b) a separate exported guard called from `main()` only; (c) inline in `main()`, unexported | **(b)** | `tooling/bench-check.ts` also imports `toSnapshotEntries`; (a) makes a valueless entry throw inside the label-gated, `continue-on-error` comparison job, where it is noise, and forecloses that tool's own `missing` verdict. (b) keeps one pure, unit-testable function and puts the policy where the publish contract lives. (c) is untestable — `tooling/` sits outside the coverage and mutation gates, so an unexported guard has no mechanical protection at all. |
| D4 | The fetch-pack bench's fresh-destination shape | (a) a fresh `createMemoryContext()` inside `sut`; (b) keep one context and remove every artefact the receive wrote after each call; (c) keep one context and receive a distinct pack per iteration | **(a)** | Measured: construction is 0.0011 ms against a 35 ms iteration (0.003%), so it does not distort the series, and it keeps the delta cache cold as a real receive faces it. (b) is coupled to the writer's artefact list — probed: removing `.pack` and `.idx` still throws on `.rev`, and the list grew last phase — and it warms the cache across iterations, quietly changing what the series prices. (c) changes the fixture the scenario is named after and would have to build packs inside the measured region. |
| D5 | tsgit refuses (and first clobbers) a re-received identical pack where git tolerates it silently — pinned, pre-existing, not introduced here | (a) bench-only in this PR; escalate the receive-path fix as the exception to the no-follow-ups rule; (b) fix it here: `materializePack` treats an occupied `pack-<sha>.*` destination as already done, checked **before** the rename so nothing is clobbered, with a cross-tool interop test pinning git's silent exit 0 and an ADR recording it; (c) fix it here minimally: catch `FILE_EXISTS` inside `materializePack` after the rename and return the existing artefacts | **(b)** | The prime directive binds every change, the divergence is user-visible (`clone` into a directory already holding the pack, and a filtered or shallow re-fetch, both throw where git succeeds), the tolerating pattern already exists in-tree, and the one test that claims to cover it cannot — it pre-creates only the `.pack`, which `rename` overwrites, so its assertion passes either way. (c) keeps the clobber-then-recover ordering git never performs. (a) is the honest option only if the user judges a receive-path behaviour change too large for a PR whose job is to un-red `main` — that judgment is the user's, which is why this is a candidate and not a decision. Under every option part C ships unchanged. |
| D6 | How ADR-724 expresses three superseding ADRs so the lint and the prose agree | (a) one bare `- **Status:** superseded by ADR-731`, all three-ADR nuance left in the block quote; (b) declare `supersedes: 724` in ADR-732 and ADR-733 too, giving three stacked bare status lines in 724 plus both anchors in each of 732 and 733; (c) (a) plus a separate non-status bullet naming ADR-732 and ADR-733 with their scopes | **(c)** | Only ADR-731 declares the supersession, so the lint demands exactly one line; extra lines are permitted. (c) is one added bullet, keeps the two other superseding ADRs visible at bullet level rather than only in prose, and duplicates nothing. (b) completes the machine-readable graph — the more principled answer — but forces near-identical "carried forward" paragraphs into three ADRs that all carry forward the same body of ADR-724, and asks for new decision prose that only the user can ratify. (a) demotes two real supersessions to prose. |
| D7 | `docs/BACKLOG.md`'s completed 30.3 entry cites ADR-723 | (a) re-point it at ADR-752, naming the addendum that survived; (b) waive the file with `DECISION-CITE-WAIVE(docs/BACKLOG.md)` on the grounds that a completed entry is history; (c) keep the reference but drop the `ADR-` prefix so the sweep stops matching | **(a)** | ADR-752 explicitly carries that addendum forward, so re-pointing keeps the sentence true and sends the reader to the live ADR. (b) waives the **whole file** — the token has no line granularity — so every future stale citation anywhere in the backlog goes unreported; it also needs a waiver file and a `--waiver-source` invocation contract that do not exist here. (c) defeats the check rather than satisfying it. |
| D8 | `docs/understand/security.md` cites ADR-541 for the root-set model | (a) cite ADR-721, naming the root-set model as what it carried forward from its predecessor; (b) waive the file; (c) cite ADR-721 and refer to ADR-541 by title only, so the sweep no longer matches | **(a)** | ADR-721 is the single authority for first-party read containment and its own body records the lineage, so one citation is both accurate and shorter; the file's opening paragraph already describes ADR-721's ruling and currently cites nothing for it. (b) is disproportionate for one line in a document that will keep citing ADRs. (c) preserves a pointer at the cost of writing a citation that deliberately evades the sweep. |
| D9 | The shape of the `bench-summarize.ts` extraction | (a) export the pure functions from `bench-summarize.ts` and guard `main()` — exactly `bench-to-snapshot.ts`'s shape; (b) a new `tooling/bench-summary-render.ts` module with a thin CLI wrapper; (c) share the raw-report types with `bench-to-snapshot.ts` | **(a)** | Smallest diff, one house pattern for two sibling scripts, two new whitelist entries instead of three, no new import specifier to get right under `node --experimental-strip-types`. (b) buys separation this ~100-line script does not need. (c) is foreclosed by ADR-056, which deliberately has each script own its read of the external vitest schema. |
| D10 | How a tsgit-only row's empty baseline cell and a no-tsgit row read | (a) tsgit-only → an em dash in the baseline cell and `n/a` speedup, no-tsgit → today's `_missing entry_` in both cells; (b) tsgit-only → `_not run_` italic marker, no-tsgit → `_missing entry_` in the tsgit cell with the baseline value still rendered; (c) tsgit-only → leave the baseline cell literally empty | **(a)** | An em dash reads as "no peer, by design" where an italic `_not run_` reads as a failure, which is precisely the confusion this part exists to remove; keeping `_missing entry_` for the genuinely anomalous shape preserves today's alarm where it belongs. (b) renders a baseline for a group that has no tsgit entry — a shape that has never occurred and would read as a comparison. (c) makes the two shapes indistinguishable from a truncated table. |

## Test strategy

`test/bench/**` and `tooling/**` sit outside the coverage and mutation gates, so the unit
tests below are the only mechanical guard and each must isolate one branch.

### Unit — `tooling/test/unit/bench-summarize.test.ts` (new, `unit` project)

Imports the exported renderers; synthetic `RawReport` values only, no artefact on disk.
Given/When/Then describe tree, AAA bodies, `sut` bound to the function under test.

| case | asserts |
|---|---|
| paired group | the exact row string, byte-for-byte against the current renderer's output |
| tsgit-only group | tsgit cell formatted identically to the paired case; empty baseline marker; `n/a` speedup |
| group with only an `isomorphic-git` entry | the "missing" rendering survives |
| group with an empty benchmark list | same "missing" rendering — the no-entry edge of the same branch |
| tsgit entry with `median` absent but `mean` present | falls back to `mean` |
| tsgit-only group whose entry has neither `median` nor `mean` nor `hz` — the real shape in today's artefact | renders as missing; does **not** throw |
| tsgit entry whose value is `0` | speedup reads `n/a`, not `Infinity×` |
| `renderSummary` over a mixed report with a fixed environment | header, separator, one row per group in file-then-group order, footnote present including the paired-rows-only clause |
| `renderSummary` over an empty report | header and footnote, no rows |

### Unit — `tooling/test/unit/bench-to-snapshot.test.ts` (extend)

| case | asserts |
|---|---|
| report where one benchmark has neither `median` nor `mean` | the guard throws; the message contains that scenario's `"<group> > <bench>"` key |
| report where two benchmarks lack both | both keys named |
| benchmark with `median` absent, `mean` present | the guard passes and `toSnapshotEntries` values it from `mean` |
| a fully-valued report | the guard is silent and existing entry assertions are unchanged |

### Unit — `tooling/test/unit/bench-dsl.test.ts` (amend)

The existing `'Given a comparison without a teardown' … 'Then neither bench receives options'`
case asserts `hooksFor` returns `{}` and **must be rewritten**, not deleted: both benches now
receive throwing options. The two teardown-routing cases keep their current assertions —
teardown still rides the last bench, still ignores `warmup` — with the options object now
also carrying `throws`.

### Suite-level proof for part C

1. `npx vitest bench --run --config vitest.bench.config.ts test/bench/fetch-pack.bench.ts`,
   then read `reports/benchmarks/raw.json` and assert the entry has `sampleCount > 0` and a
   numeric `median`. A green exit code proves nothing on its own — that is the defect.
2. A throwaway scenario whose `sut` throws, run under `vitest bench` to show a non-zero exit
   with the error visible, then deleted. It is never committed.
3. The whole `npm run test:bench` sweep, then `tooling/bench-to-snapshot.ts`, then a
   `sampleCount > 0` check across every entry in `raw.json` — this is what proves no *other*
   scenario was failing silently and is now red.
4. Part A on the real artefact: point the renderer at the nightly `raw.json` copy and count
   rows containing `missing`. Against the **pre-fix** artefact the count is **1** — the
   fetch-pack scenario, correctly flagged as unmeasured by the uniform anomaly branch — down
   from today's 81. Against a locally re-measured `raw.json` it is **0**. Record both counts
   in the run record; reporting only "0" would hide which artefact was used.

### Conditional on D5 — the receive path

Only if D5 lands on (b) or (c). A cross-tool interop test in
`test/integration/*-interop.test.ts` receives one pack twice and asserts the second call
succeeds with the artefacts unchanged, with real `git` reproducing the same sequence in the
same fixture — parity tests are cross-adapter and prove nothing about faithfulness. Unit
coverage extends to both adapters, since `writeExclusive` refuses identically on each. The
existing `fetch-missing` tolerance test is repaired in the same slice: it pre-creates only the
`.pack`, which `rename` overwrites, so the refusal it claims to exercise is never reached and
its assertion cannot distinguish the two outcomes — it must pre-create the sibling the writer
actually collides on. Under D5(a) none of this ships and the divergence is escalated instead.

### Verification for part B

Re-run the lint from the worktree root; the expected output is the exempt-set banner on
stderr and one `craft-adr: OK — <N> ADR(s) checked, <M> declaring supersession.` line on
stdout, exit 0. Under D6(b) the declaring count rises from 4 to 6; under D6(a) or D6(c) it
stays at 4.

### Property tests — the four lenses, and why none fits

Checked deliberately rather than skipped. **Round-trip pair:** none — nothing here parses what
another function serialises; the renderers are one-way and the converter's output is consumed
by an external action. **Compositional matcher or aggregator:** `renderRow` maps one group to
one string and `renderSummary` concatenates rows in order; there is no verdict to invert, no
identity element, no negation. **Total function over an algebraic grammar:** the input grammar
is a fixed three-shape enumeration (paired, tsgit-only, no tsgit), which the example sweep
above covers exhaustively — a generator would only re-draw those three. **Idempotence or
counting invariant:** the row count is trivially the group count, and asserting it would
restate the `map`. A property over the renderers would have to re-implement the format string
as its oracle, which is a tautology, not a property. No `*.properties.test.ts` sibling ships,
and this paragraph is the recorded reason.

### Gates

`npm run validate` is the ground truth. `npx cspell` is run bare over any touched
`docs/design` or `docs/plan` page, since the commit hook does not spell-check those
directories. If a gate times out on tests outside the diff, that is oversubscription — re-run
with `WIREIT_PARALLEL=1`, never `--no-verify`.

## Out of scope

- **Weakening `writeExclusive`** on either adapter. The exclusive write is the correct
  primitive; if D5 is taken, the fix is a tolerant caller, never a permissive file system.
- **Changing any snapshot series key.** Every describe title and both bench names stay
  byte-identical; a renamed key silently starts a new gh-pages series and orphans the old one.
- **Any `src/` change beyond what D5 resolves.** If D5 lands on (a), this PR touches no
  production source at all.
- **An N-competitor summary renderer.** Foreclosed by ADR-480; part A fixes rendering within
  the two-name keying.
- **Sharing a raw-report schema between the two bench tooling scripts.** Foreclosed by
  ADR-056.
- **Wiring `adr-lint` into an npm script, a CI job or a hook.** It is invoked manually from
  the craft engine today; making it a gate is its own change with its own waiver-file
  contract.
- **Rebuilding the lost `main` fixture cache entry.** Self-healing on the first green run
  after merge; recorded above so the slow run is not misread.
- **Adding words to `cspell.json`.** A spelling failure is reworded, never added to the dictionary.
