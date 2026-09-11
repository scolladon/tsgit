# Plan — closure and history walks

> Source: design doc `docs/design/closure-history-walks.md` · ADRs `836–845`
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

## Order and dependencies

```text
 1   harness            test-infra only; MUST be first — it is the only source of a
                        "before" number for the renamed and brand-new bench rows
 2   closure prune      (a)+(b) merged: the maxDepth hoist is one field of the
                        TreeEmitScope part (a) introduces
 3   push               needs 2 (inherits the prune); changes the pushed object set
 4   walk-commits       independent of 2/3; may be reordered anywhere after 1
 5   until + buffer     touches the same closure-engine function as 2 → after 2
 6   readCommitMeta     new internal module + bisect-midpoint; prerequisite for 7 and 8
 7   merge-base         needs 6
 8   name-rev           needs 6
 9   blame -L           independent; may be reordered anywhere after 1
10   date walk + diffs   independent; may be reordered anywhere after 1
```

Hard edges: **2 → 3**, **2 → 5**, **6 → 7**, **6 → 8**. Everything else is
independent and could be permuted; the order above keeps every file touched by
exactly one part except the three named under "Shared files across parts" below.

## Public-surface decisions (decided here, pre-paid in-part)

| New/changed symbol | Verdict | Gates the part pre-pays |
|---|---|---|
| `WalkTreeOptions.skipTree` (ADR-836) | **PUBLIC** | `npm run docs:json` → commit `reports/api.json` **in Part 2**. `docs/use/primitives/walk-tree.md` row → docs phase. |
| `WalkCommitsOptions.until` / `WalkCommitsByDateOptions.until` widened to `ReadonlyArray \| ReadonlySet` (ADR-838) | **PUBLIC** | `npm run docs:json` → commit `reports/api.json` **in Part 5**. `walk-commits.md` / `walk-commits-by-date.md` rows → docs phase. |
| `readCommitMeta`, `commitMetaOf`, `CommitMeta`, `GENERATION_INFINITY` (`primitives/internal/read-commit-meta.ts`) | **INTERNAL** | Not barrel-exported. `primitives/index.ts` is untouched. Still run the api.json check (doc comments on public types can drift the report). |
| `TreeEmitScope`, `WalkedCommit` (closure-engine locals) | **INTERNAL** | None. Not exported. |
| `NameRevCutoff`, `commitIsBeforeCutoff`, `nameRevCutoff` signature change (`domain/name-rev/`) | **INTERNAL** | `domain/name-rev/index.ts` is explicitly "NOT re-exported from `domain/objects` — these stay out of the public `api.json`" (its own module doc). |
| `RenderedPatch`, `renderRangePatch` re-exported from `domain/range-diff/index.ts` | **INTERNAL** | 0 hits in `reports/api.json` today; the barrel is domain-internal. Verify with the api.json check. |
| `BlameOptions.range` doc comment (ADR-844), `mergeBase` doc comment (ADR-845), `WalkTreeOptions` doc comments | unchanged types, **changed doc text** | typedoc embeds doc comments, so `reports/api.json` **does** move. Run the api.json check in Parts 2, 5, 7, 9. |

**No new Tier-1 command, no new error code, no new barrel entry.** The full Tier-1
gate set (facade binding, `repository.test.ts` key snapshot, `check:doc-coverage`,
`audit-browser-surface`, README count) is therefore **not** triggered by any part.

## Standing rules — every part, no exceptions

- **Green gate before commit.** Never commit on a red part gate. Never `--no-verify`.
- **Run every gate bare into a file and `echo $?`.** `npm run x | tail` reports exit 0
  on a red run. `npm run check:types` / `check:spelling` are wireit-cached: when the
  output says `Ran 0 scripts and skipped 1`, that is a cache hit, not a gate — re-run
  bare with `npx tsc --noEmit -p tsconfig.json` and `npx cspell --no-progress <files>`.
- **`reports/api.json` is a PREPUSH gate, not a validate gate.** In every part that
  touches `src/`: run `npm run docs:json`, then `git diff --stat -- reports/api.json`.
  Non-empty ⇒ commit it with the part. Empty ⇒ nothing to commit. Do not hand-edit it.
- **No suppression directives**: no `@ts-ignore`, `v8 ignore`, `stryker-disable`
  (except the equivalence comments this plan names explicitly), `biome-ignore`. Refactor
  to pass the rule honestly.
- **No provenance refs in source or test code** — no `§`, `Phase`, `ADR-nnn`, `31.1`,
  backlog ids inside `src/**` or `test/**`. The commit message is the join point.
- **Test conventions**: `describe('Given …')` > `describe('When …')` > `it('Then …')`
  (2-level shortcut allowed when one expectation lives under the When); AAA body with
  section comments; the system under test is the variable `sut` (never the result — the
  result goes in `result`). Error assertions assert `.data` (code + reason/message),
  never `toThrow(ErrorClass)` alone. A guard `if (A || B) throw` needs one test per
  condition triggered alone. 100 % line/branch/function/statement coverage: a new guard
  arm without its own test row turns the coverage gate red at the phase-boundary
  validate.
- **Property tests**: no part introduces a parser, serializer, matcher or round-trip
  pair, so the four lenses do not fire and **no new** `*.properties.test.ts` is owed. The
  blame window resolver (Part 9) is a total function over small integers — a
  parameterised example sweep is the clearer proof. **But one property suite already
  exists on code this change touches**: `test/unit/domain/name-rev/cutoff.properties.test.ts`
  (4 properties over the current scalar `commitIsBeforeCutoff(date, cutoff)` /
  `nameRevCutoff(date)` signatures). Part 8 changes both signatures, so those properties
  must be **migrated**, never deleted — properties are additive and an example test is
  never dropped to make room.
- **Serena is already activated** on this worktree — never call `activate_project`. The
  graft MCP server is down this session. Use `command grep` (never bare `grep` — the
  hook rewrites it to `rtk grep`, which truncates at ~200 results with no warning),
  `sed -n`/`awk` for line-anchored reads, and serena's symbol tools for edits and for
  any "who references this re-exported symbol" question. LSP/serena diagnostics are
  advisory; `npx tsc --noEmit -p tsconfig.json` is ground truth.
- **A green `tsc` is not a consumer sweep when a type WIDENS.** Part 5 widens `until`;
  every existing array caller still type-checks unchanged. Sweep by **value shape**
  (`until: [...someSet]`), not by name. The full list is in Part 5's context.
- **State-mutating git probes run in a `mktemp -d` throwaway** with an isolated `HOME`,
  `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed and signing OFF — **never** in this
  worktree, which shares `.git/config` with the main checkout through the common dir.
  `-C <path>` does NOT override an inherited `GIT_DIR`.
- **"Pre-existing failure" claims are verified against `main`**, never against an
  earlier commit on this branch.
- **`docs/perf/baseline.json` / `baseline.md` are NOT regenerated by any part.** The
  branch's first commit already refreshed them and the workload set does not change.
  `npm run profile` writes them — do not run it as a "let's see" step.
- **Confirm a scripted edit landed** before trusting a gate: `git diff --stat` must show
  the file. Biome re-wraps statements, so an edit anchored on a statement can abort
  silently and the gate then runs green on the unfixed tree.
- **The zsh Bash tool passes an unquoted `$FILES` holding several paths as ONE
  argument** — `biome check $FILES` then checks 0 files and exits 0. Always spell the
  paths out explicitly in the gate command.
- **Poll, don't wait**: never end a turn waiting on a background notification.
- **Commit only the part's own files.** Never `git add -A`. Never change repo-wide git
  state — the branch, the stash, another agent's staged work, worktrees. The commit IS
  the handoff: a part that dies is re-spawned from it.
- **Escalate, never spin**: a blocker is `{ part, reason, ≤3 options }`.

## Gate vocabulary

- **Part gate** (per part; placeholders resolved in each part's `### Gate`):
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files> && npm run check:spelling`,
  plus the bare bypasses `npx tsc --noEmit -p tsconfig.json` and
  `npx cspell --no-progress <files>` whenever wireit reports `Ran 0 scripts and skipped 1`.
- **Phase gate** (orchestrator, after the last part): `npm run validate`, then
  `npm run bench:ab -- main perf/closure-history-walks 2`. In that A/B the rows that
  exist on both sides (`log()` medium, `log()` via commit-graph, `describe()`, the
  `name-rev()` tiered rows, `blame()`, `maintenance gc`) compare normally and the bar is
  **not worse**; the two renamed closure rows, the two direct tier rows, the many-tag arm
  and both wide-tree rows report `new`/`missing` and are read from the in-branch
  before/after pairs the parts recorded (PC-1). `benchmark-compare` is
  `continue-on-error` and `docs/perf/hot-paths.json` names no closure row, so the
  knowingly-retired series break nothing — **say so in the PR body**.
- **Targeted extras** named per part: `npm run docs:json` (regenerates
  `reports/api.json`; a **prepush** gate `validate` does not catch),
  `npm run test:integration` (interop suites), `npm run build:profile` (the
  `dist-profile` bundle the perf oracles import), `npx vitest bench --run --config vitest.bench.config.ts <file>`.

## Decision candidates

Everything the design put to the user is settled in ADRs 836–845 and carried below as
fact. Three load-bearing choices surfaced by planning are **not** covered by those
ADRs; each carries a recommendation and none is decided here.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| PC-1 | How the renamed and brand-new bench rows get a "before" number. `npm run bench:ab -- main <branch> 2` intersects the two trees' bench **files** and then compares by **series key**; `closure-wide-tree.bench.ts` does not exist on `main` (dropped entirely) and the two renamed closure rows plus the many-tag arm produce keys `main` never had (reported `new`/`missing`, never compared). The design's "oracle is absolute time on the 300-commit row, main vs branch (`bench:ab`)" cannot be satisfied as written. | (a) **In-branch before/after**: Part 1 lands the harness with `src/` untouched and records every new/renamed row's median; the part that changes the code re-runs the same row and reports both absolutes. (b) Copy the new bench file into a throwaway detached worktree of `main` and run `vitest bench` on both sides by hand. (c) Report the branch-side absolute only, with no baseline. | **(a)** | It is exactly why D0 orders the harness first ("so every later part's A/B has before/after on the same keys"); same machine, same fixture, same process shape, and no repo-wide git state is created by a part agent. (b) duplicates `bench-ab`'s worktree machinery inside a part agent, which the contract forbids. (c) forfeits R6's oracle. |
| PC-2 | `mergeBase({ all: true })` result **ordering**. ADR-845 supersedes only "the single-base selection rule"; git's `--all` prints date-sorted newest-first (Pin P5) while tsgit returns `[...bases].sort()` (oid-ascending, `merge-base.ts:162`, documented at `merge-base.md:3`). | (a) Keep the oid sort for `--all`; compute the single result separately as the newest base; pin `--all` as a **set** in interop, as the design's test table says. (b) Switch `--all` to git's date order too (a second, un-ADR'd behaviour change inside a perf change). (c) Sort `--all` by date and return `sorted[0]` (couples the two rules, same behaviour change as (b)). | **(a)** | ADR-845's scope line is explicit: the single-base selection rule only. `--all`'s oid ordering is a documented, ADR-189-era contract with its own doc sentence; changing it is out of scope and unpinned. Note the consequence honestly in the part: `mergeBase({all:true})[0] !== mergeBase()[0]` in a criss-cross history, by design. |
| PC-3 | The object-read counter used by the "zero object reads after the graph load" oracle. The commit-graph file lives at `objects/info/commit-graph`, so today's `path.includes('objects/')` filter (`name-rev.test.ts:544-556` `withCountedObjectReads`) counts the **graph probe** as an object read — and after Part 6 every consumer probes the graph once per `Context`, even when none exists. The existing one-read pins (`expect(reads()).toBe(1)`) would move for a reason that is not a regression. | (a) Narrow the filter to real object-store reads: `objects/pack/` or `objects/<2 hex>/`, excluding `objects/info/`; keep the existing expected counts. (b) Keep the broad filter and re-baseline every expected count to include the memoised graph probe. (c) Count by `method` instead of path (cannot distinguish the graph file from a loose object). | **(a)** | It is the design's own wording ("the graph file under `objects/info/` excluded") and it keeps the existing pins meaning what they were written to mean. (b) makes every pin a function of an unrelated memoised probe; (c) does not work. |

## Docs-drift handoff (docs phase owns the pages; parts own the source doc comments)

Each part updates the **doc comments in the source it touches**. The pages below are
the docs phase's list, sourced here so it needs no rediscovery. Line anchors verified
on this worktree.

| Page | Line(s) | What is stale after this change | Owed by |
|---|---|---|---|
| `docs/use/primitives/walk-tree.md` | 30–36 (options table) | New `skipTree` row — placed in **declaration order** (the table mirrors `types.ts`, it is not alphabetical); `maxEntries` row must say the counter counts entries **visited**, so a pruned subtree's entries no longer count toward `TREE_ENTRY_LIMIT_EXCEEDED`. | Part 2 → docs phase |
| `docs/use/primitives/walk-commits.md` | 8–16 | `until` type widening. Also **pre-existing drift, four separate errors**: `from` is a required `ReadonlyArray<ObjectId>` not an optional `RefName \| ObjectId` defaulting to `'HEAD'`; the doc calls `until` `excluding`; the doc has `firstParent?: boolean` where the type has `order?: 'topo' \| 'first-parent'`; `ignoreMissing` and `verifyHash` are undocumented. Flagged, not owned by any part. | Part 5 → docs phase |
| `docs/use/primitives/walk-commits-by-date.md` | 17 | `until` type widening. This file is otherwise accurate — use it as the template for repairing `walk-commits.md`. | Part 5 → docs phase |
| `docs/use/commands/blame.md` | 87–89 | "an inverted range … refuses (`INVALID_OPTION`)" — inverted bounds now **swap** (ADR-844). | Part 9 → docs phase |
| `docs/use/commands/push.md` | 102 | The only object-selection mention is a "See also" link to `enumeratePushObjects`; `push` no longer uses it. | Part 3 → docs phase |
| `docs/use/primitives/internals.md` | 45–47 | `enumeratePushObjects` — "Diff local vs remote heads to compute the push-pack object set. Used by [`push`]" is doubly stale: it never was a diff (it over-reports; the haves' object closure is never subtracted), and `push` no longer calls it. Say what it does, say `push` no longer uses it, say a later item owns its deletion — **without a backlog id in the page's prose beyond what the docs phase normally writes**. | Part 3 → docs phase |
| `docs/use/primitives/merge-base.md` | 3, 5 | "sorted by oid" stays true for `{all:true}` (PC-2); "the lexicographically smallest, mirroring `git merge-base`" is wrong — the single base is the **newest** (ADR-845). | Part 7 → docs phase |
| `docs/use/commands/rev-list.md`, `pack-objects.md` | — | **Unchanged**: the prune changes no tier. | — |
| `docs/use/commands/name-rev.md` | 52–55 | Accurate today; after Part 8 the "prunes commits older than the target's committer date minus one day" sentence needs the graph clause (generation **replaces** the date test when the target has a generation). | Part 8 → docs phase |
| `docs/BACKLOG.md` | 576 | Tick 31.1 with the design/ADR suffix only. | docs phase |

## Shared files across parts (plan-lint overlap — deliberate)

`plan-lint` warns on a file declared by two or more parts. Three are intentional and
none is mergeable:

- `src/application/primitives/internal/closure-engine.ts` — Part 2 rewrites `emitTree`
  and its three call sites; Part 5 rewrites `walkAndEmitCommits`'s buffer and its
  `until`. Different functions, different commits (`perf` vs `feat`), different public
  surfaces. Part 5 runs after Part 2 in one working tree.
- `src/application/primitives/types.ts` — Part 2 adds `skipTree`, Part 5 widens
  `until`. Two independent public-surface additions with two independent `api.json`
  regenerations; merging them would put a `feat` and a `perf` in one commit.
- `src/application/primitives/internal/read-commit-meta.ts` — created by Part 6,
  consumed by Parts 7 and 8. Consumers declare it to know its exact contract.

## Part 1 — Bench harness: price the closure tiers honestly, add the wide-tree and many-tag arms

### Context

**Test-infra only. No `src/` delta.** This part is legitimately standalone under the
sizing rules and it MUST land first: it is the only source of a "before" number for
the rows that no `main` baseline can supply (PC-1).

**Files touched**
- `test/bench/closure.bench.ts` (96 lines, whole file is in scope)
- `test/bench/fixtures.ts` (add one fixture builder next to `setupBitmapClosureFixture`)
- `test/bench/closure-wide-tree.bench.ts` (**new**)
- `test/bench/name-rev.bench.ts` (78 lines; add one arm)

**The bench DSL** — `test/bench/support/bench-dsl.ts`:
- `benchScenario(given: string, whenThen: string, build: () => Promise<BenchComparison> | BenchComparison, opts?: { skip?: boolean })` (`:107-126`). It declares one
  `describe(\`${given}, ${whenThen}\`)` — **comma-space join** — and inside it registers
  `bench('tsgit', comparison.sut, hooks.tsgit)` and, only when `comparison.baseline`
  exists, `bench('isomorphic-git', …)`. The two bench names are literal and must never vary.
- `interface BenchComparison` (`:36-55`) = `{ sut: () => Promise<void>|void; baseline?: …; teardown?: () => Promise<void>|void }`.
- **vitest 4's bench runner calls no suite hooks.** There is no `afterAll`. `teardown`
  is the only cleanup that ever runs, it is attached to whichever bench runs last, it is
  **not awaited**, and it must therefore be synchronous — use `removeSync` from
  `./support/fixture-scratch.js`, never `rm`.
- Every bench uses `throws: true`, so a throw during warmup aborts the whole bench
  **file** and later scenarios never run.

**Snapshot series keys** — `tooling/bench-to-snapshot.ts:57-58`:
`benchmarkKey = \`${group.fullName} > ${bench.name}\``. Renaming a scenario title
retires one series and starts another. `tooling/bench-check.ts:47-52` reports a key
present only in the current run as `new` and one present only in the baseline as
`missing`; a row only `regress`es when `deltaPct > thresholdPct`. `benchmark-compare`
is `continue-on-error` and `docs/perf/hot-paths.json` names no closure row, so the
break is knowingly non-blocking. **Say so in the PR body.**

**`closure.bench.ts` as it stands**
- imports at `:13-24`; `const CLOSURE_FIXTURE_COMMITS = 500;` at `:27`.
- `assertClosureAnsweredByBitmap(fixture)` (`:40-53`) already builds the exact direct
  call the new rows need: `computeClosure(ctx, { wants: [fixture.headCommitId as ObjectId], not: [], objects: true, tier: 'bitmap' })`,
  with `createNodeContext({ workDir: fixture.cwd, hooks: false, command: false, ssh: false })`.
  It throws when the tier falls back.
- `closureComparison(buildSut)` (`:55-70`) builds the fixture, asserts the bitmap
  answered, opens the repository and returns `{ teardown, sut }`.
- Scenario 1 (`:72-78`), title `'When revList() computes the closure at its own default (a walk), Then measure tsgit'`,
  `sut` = `repo.revList({ wants: [headCommitId] })`.
- Scenario 2 (`:80-96`), title `'When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit'`,
  `sut` clears `bench-pack-out` with `rm` then calls `repo.packObjects({ wants, outputDirectory })`.
- Both share `given` = `` `Given a ${CLOSURE_FIXTURE_COMMITS}-commit repository with a healthy bitmap` ``.

**`setupBitmapClosureFixture(commits)`** lives in `test/bench/fixtures.ts:396-417`
(NOT in the bench file): `mkdtemp` → `openRepository({cwd}).init()` → `dispose()` →
`createNodeContext(...)` → `buildLinearChain` → `writeSyntheticPack` →
`writeHealthyChainBitmap`. `BitmapClosureFixture` is `{ cwd, headCommitId }`
(`fixtures.ts:380-383`).

**Renames to apply** (design D12 — the exact target strings):

| Old `whenThen` | New `whenThen` |
|---|---|
| `When revList() computes the closure at its own default (a walk), Then measure tsgit` | `When revList() walks the commits-only closure at its own default tier, Then measure tsgit` |
| `When packObjects() computes the closure at its own default (a usable bitmap), Then measure tsgit` | `When packObjects() answers the objects closure from its default bitmap tier, deltifies and writes the pack, Then measure tsgit` |
| — (new) | `When computeClosure({ objects: true, tier: 'walk' }) walks the full objects closure, Then measure tsgit` |
| — (new) | `When computeClosure({ objects: true, tier: 'bitmap' }) answers the full objects closure from the bitmap, Then measure tsgit` |

The two new rows call `computeClosure` directly on the same fixture, reusing the
`createNodeContext` line from `assertClosureAnsweredByBitmap`. Build the `Context` once
in `build()`, not per iteration.

**New `test/bench/closure-wide-tree.bench.ts`** — the shape the prune actually pays off
on. Add `setupWideTreeClosureFixture(commits: number)` to `test/bench/fixtures.ts`,
in-process and synthetic (never `git`, never the shared `~/.cache/tsgit-bench` cache,
which is READ-ONLY for benches):
- bootstrap exactly as `setupBitmapClosureFixture` does (`mkdtemp` → `openRepository({cwd}).init()` → `dispose()` → `createNodeContext({ workDir: cwd, hooks: false, command: false, ssh: false })`);
- 40 directories × 50 files = 2 000 blobs. Write blobs with
  `writeObject(ctx, { type: 'blob', id: '' as ObjectId, content })` from
  `src/application/primitives/write-object.js`; build each directory tree with
  `writeTree(ctx, entries)` from `src/application/primitives/write-tree.js` (entries via
  `treeEntry` from `src/domain/objects/tree.js`); commit with
  `createCommit(ctx, { tree, parents, author, committer, message })` from
  `src/application/primitives/create-commit.js` (`CreateCommitInput`, `types.ts:243-251`);
- 300 commits, each rewriting **one** file in **one** directory, round-robin, so every
  commit has a distinct root tree and exactly one distinct changed subtree;
- loose objects are fine — the subject is the CPU-bound warm closure, not object reads.
- Rows: `computeClosure({ wants: [head], not: [], objects: true, tier: 'walk' })` at
  **100** and **300** commits, two `benchScenario` blocks.
- Expected shape (design correction 9): ≈ 2 040 entry visits per commit before the
  prune (root + every subtree re-descended), ≈ 91 after (root 40 + changed subtree 50 +
  1 blob). **Both** the 100- and 300-commit rows scale ≈ 3× on both trees — the closure
  is linear in commits with a small slope, **not flat**. Do not write "flat" anywhere.

**New `name-rev.bench.ts` arm.** That file uses the *tiered* DSL
(`tieredScenario` + `MULTI_TIERS` from `./support/tiered-bench.js`), which resolves the
shared read-only cache and, in `ensurePrunableTaggedTip` (`:51-63`), shells out to real
`git` with a scrubbed env. **The new arm must not go through the tiered path and must
not touch the shared cache** (fixtures there are read-only for benches): declare it as
its own `benchScenario` over an in-process scratch repository — 200 commits and 200
lightweight tags spread over the history, tag refs written directly through the
`Context` — titled
`'When name-rev() names a commit under 200 tags, Then measure tsgit'`.

**Constraint on `bench:ab`.** `tooling/bench-ab.ts` intersects the two trees' bench
files (`intersectBenchFiles`, `:58-64`) and compares by series key, so
`closure-wide-tree.bench.ts` is dropped entirely against `main` and the four renamed /
new keys in `closure.bench.ts` and `name-rev.bench.ts` report `new`/`missing`. This is
expected. The before/after for all of them is the in-branch pair PC-1 recommends, which
is why this part records "before" numbers.

### TDD steps

1. **RED — the wide-tree fixture proves it runs.** Create
   `test/bench/closure-wide-tree.bench.ts` with both scenarios and
   `setupWideTreeClosureFixture` stubbed to `throw new Error('wide-tree fixture not built')`.
   Run `npx vitest bench --run --config vitest.bench.config.ts test/bench/closure-wide-tree.bench.ts` bare into a file and
   `echo $?`. Expected failure: that exact message, aborting the file (`throws: true`).
2. **GREEN — build the fixture.** Implement `setupWideTreeClosureFixture` in
   `test/bench/fixtures.ts`. Re-run. Then assert the harness actually measured:
   `node -e` over `reports/benchmarks/raw.json` and confirm **both** new keys carry
   `sampleCount > 0`. A green `vitest bench` alone proves nothing — a warmup error is
   swallowed as a zero-sample pass.
3. **RED — the direct tier pair.** Add the two `computeClosure` rows to
   `closure.bench.ts` **before** wiring their `Context`, i.e. with
   `tier: 'bitmap'` on the row that must walk. Run
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/closure.bench.ts`; the walk row measures the bitmap and
   the two new rows are indistinguishable in `raw.json`. That is the red: the rows do
   not yet price different code.
4. **GREEN — wire the tiers.** Set `tier: 'walk'` / `tier: 'bitmap'` per row; re-run;
   confirm the two medians differ by more than run-to-run noise and both carry
   `sampleCount > 0`.
5. **GREEN — apply the two renames** exactly as tabulated above.
6. **GREEN — the many-tag arm** in `name-rev.bench.ts`; run
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/name-rev.bench.ts`; confirm `sampleCount > 0` on the new key.
7. **REFACTOR** — factor the shared `createNodeContext(...)` line for the two direct
   rows; keep `teardown` synchronous (`removeSync`); keep every bench name `'tsgit'`.
8. **RECORD (hand-off, not an assertion).** Run each bench file once more and copy the
   medians for: the two renamed closure rows, the two direct tier rows, both wide-tree
   rows, and the many-tag arm. Put all seven numbers, with the machine and Node version,
   in the part's final message. Parts 2 and 8 re-run the same files and report the
   "after" column against these.

### Gate

```
npx vitest bench --run --config vitest.bench.config.ts test/bench/closure.bench.ts test/bench/closure-wide-tree.bench.ts test/bench/name-rev.bench.ts 2>&1 | tee /tmp/p1-vitest.log; echo $?
npm run check:types 2>&1 | tee /tmp/p1-types.log; echo $?
npx tsc --noEmit -p tsconfig.json 2>&1 | tee /tmp/p1-tsc.log; echo $?
./node_modules/.bin/biome check test/bench/closure.bench.ts test/bench/closure-wide-tree.bench.ts test/bench/fixtures.ts test/bench/name-rev.bench.ts 2>&1 | tee /tmp/p1-biome.log; echo $?
npm run check:spelling 2>&1 | tee /tmp/p1-spell.log; echo $?
npx cspell --no-progress test/bench/closure.bench.ts test/bench/closure-wide-tree.bench.ts test/bench/fixtures.ts test/bench/name-rev.bench.ts 2>&1 | tee /tmp/p1-cspell.log; echo $?
```
Bench files register no `it`, so the default `vitest run` include does not pick them up —
`npx vitest run test/bench` would exit non-zero with "no test files found". The bench
config (`vitest.bench.config.ts`: `include: ['test/bench/**/*.bench.ts']`,
`outputJson: 'reports/benchmarks/raw.json'`, `testTimeout: 120_000`) is what runs them,
and that run is both the compile check and the measurement. No `src/` change ⇒ no
`npm run docs:json` needed, but run it anyway and confirm the diff is empty.

### Commit

```
test(bench): price the closure tiers honestly and add wide-tree and many-tag arms
```

## Part 2 — The closure prune: `skipTree`, the root short-circuit, and one `maxTreeDepth` read

### Context

The largest win in the change: `revList({ wants: [HEAD], objects: true })` on the
medium fixture takes **39.3 s warm with zero file reads** where
`git rev-list --objects HEAD` takes **0.11 s** (357×), and issues **10 010**
`stat .git/config` calls. Two defects stack, and both are fixed here — the depth hoist
is one field of the scope this part introduces, which is why (a) and (b) are one part.

**Mechanism (git).** `list-objects.c:149-199` `process_tree`:
`if (obj->flags & (UNINTERESTING | SEEN)) return;` then `obj->flags |= SEEN`. Each
distinct tree is expanded once, and an uninteresting tree is never expanded on the
interesting side. `process_tree_contents` (`:100-147`) skips gitlinks.

**Files and exact anchors**

`src/application/primitives/types.ts`
- `WalkTreeOptions` at `:188-210`: members in declaration order `recursive`, `maxDepth`,
  `maxEntries`, `pathHasher`, `pathBytes`. Add `skipTree` — its slot in the interface
  is what the docs table must mirror.

```ts
  /**
   * Prune: when it returns `true` for a directory entry's id, that entry is
   * still yielded but its subtree is not entered. Evaluated once per directory
   * entry, after the recursion check and BEFORE the entry is yielded — a
   * consumer that reacts to the yield cannot influence the verdict. Never
   * called for a blob or a gitlink entry. Absent, the walk is unchanged.
   */
  readonly skipTree?: (id: ObjectId) => boolean;
```

`src/application/primitives/walk-tree.ts` (286 lines)
- `interface WalkConfig` `:29-36` — add `readonly skipTree?: (id: ObjectId) => boolean`.
- `resolveWalkConfig` `:125-137` — spread `skipTree` conditionally, exactly like
  `pathHasher` at `:135`. `maxDepth: options?.maxDepth ?? (await resolveMaxTreeDepth(ctx))`
  at `:132` is the line the hoist makes skip its `await`.
- `interface FrameStep` `:139-151` — add `readonly descend: boolean`. Keep it a **fixed
  shape** (the existing comment at `:142-146` explains why the hot per-entry path must
  not pay for a conditional spread).
- `nextFrameEntry` `:158-175` — compute
  `const descend = shouldRecurse(config.recursive, entry.mode) && !(config.skipTree?.(entry.id) ?? false);`
  and return it. **Order matters**: `shouldRecurse` first, so `skipTree` is never called
  for a blob or a gitlink (`shouldRecurse` at `:273-278` returns `isDirectory(mode)`,
  which already rejects gitlink mode 160000).
- `walkTree` loop `:255-270`: today `yield` at `:263`, `if (!shouldRecurse(...)) continue;`
  at `:264`, `readObject` at `:265`, `enterTree` at `:268`. Destructure `descend` at
  `:262`, keep the `yield`, replace `:264` with `if (!descend) continue;`.
- **The pre-yield evaluation is the load-bearing detail.** The closure's consumer emits
  the directory entry while the generator is suspended at the `yield`, so a post-yield
  `emitted.has(entry.id)` check would be `true` for **every** subtree and the walk would
  emit nothing below the root.
- Twelve callers of `walkTree` are untouched: the member is optional and is never
  called when absent.

`src/application/primitives/internal/closure-engine.ts` (308 lines)
- `emitTree` `:121-140`, signature today
  `(ctx, treeId, marked: ReadonlySet<ObjectId>, emit: Emit): Promise<void>`; it emits the
  root when `!marked.has(treeId)` (`:127-129`) then `walkTree(ctx, treeId, { pathHasher: PACK_NAME_HASH_V1 })`
  (`:130`), `continue`s on gitlink (`:131`) and on `marked.has(entry.id)` (`:132`).
- New scope type and body:

```ts
interface TreeEmitScope {
  readonly marked: ReadonlySet<ObjectId>;   // marks.objects, or NO_MARKS for a tree want
  readonly emitted: ReadonlySet<ObjectId>;  // state.emitted — the LIVE set, by reference
  readonly maxDepth: number;                // marks.maxDepth
}

async function emitTree(ctx, treeId, scope: TreeEmitScope, emit): Promise<void> {
  // git's process_tree: UNINTERESTING | SEEN → return, before anything is shown
  if (scope.marked.has(treeId) || scope.emitted.has(treeId)) return;
  emit({ id: treeId, type: 'tree', path: ROOT_PATH, nameHash: PACK_NAME_HASH_SEED });
  const skipTree = (id: ObjectId): boolean => scope.marked.has(id) || scope.emitted.has(id);
  for await (const entry of walkTree(ctx, treeId, {
    pathHasher: PACK_NAME_HASH_V1,
    maxDepth: scope.maxDepth,
    skipTree,
  })) {
    if (isGitlink(entry.mode)) continue;
    if (scope.marked.has(entry.id)) continue;
    emit({ … unchanged … });
  }
}
```

  **`scope.emitted` MUST be `state.emitted` itself, never a copy** — the prune reads a
  set that grows as the walk emits. A copy makes the whole part inert and every test
  still passes except the read-count ones.
- Three call sites take the scope: `resolveWants:165` (tree want — `{ ...scope, marked: NO_MARKS }`),
  `emitSeedsWithoutWalking:194`, `walkAndEmitCommits:226`.
- `resolveWants` `:149-173` gains a `scope` parameter. `walkClosure` `:244-257` already
  awaits `markNotSide` at `:252` **before** `resolveWants` at `:253`, so `marks.maxDepth`
  is available; build the scope there:
  `const scope: TreeEmitScope = { marked: marks.objects, emitted: state.emitted, maxDepth: marks.maxDepth };`
- The old root guard `if (!marked.has(treeId))` becomes the early `return` — note the
  behaviour is **not** identical for a marked root: today the walk still ran and rejected
  every entry; now it returns. That is the point (ADR-837), and it is output-identical.

`src/application/primitives/internal/closure-not-marks.ts`
- `NotMarks.maxDepth` `:39-41` is already the closure-wide value, resolved once in
  `markNotSide` `:157` via `resolveMaxTreeDepth`. **Nothing in this file changes.** The
  hoist is purely `maxDepth: scope.maxDepth` on the `walkTree` call.
- `resolveMaxTreeDepth` (`internal/resolve-max-tree-depth.ts:16-23`) issues exactly two
  config reads (`findLastInvalidMaxTreeDepth` at `:17`, `readConfig` at `:21`). After the
  hoist the closure pays those two once, plus the command gate's — O(1), not 10 010.
  ADR-637's `CONFIG_BAD_NUMERIC_VALUE` refusal still fires, once, from `markNotSide`.
- `enumeratePushObjects` keeps its own per-call resolution (`:70`); it leaves push's path
  in Part 3 and a later item deletes it.

**Refusal surfaces touched (tsgit-only guards, no git counterpart)**
- `TREE_ENTRY_LIMIT_EXCEEDED` (`MAX_FLAT_TREE_ENTRIES`, per `walkTree` call, `walk-tree.ts:164-166`)
  now counts entries **visited** under the prune. A first visit of an over-limit tree
  still refuses.
- `TREE_CYCLE_DETECTED` (`enterTree:117`): through the closure a self-containing tree
  becomes unreachable (the second encounter is `emitted`, so it is skipped) — exactly
  what git's `SEEN` return does. `walkTree` alone still detects it.
- `TREE_DEPTH_EXCEEDED`: unchanged. Depth is checked in `enterTree` on every frame
  actually entered; a deep tree is entered in full on its first encounter.
- `PACK_TOO_LARGE` (`object-emit.ts:16-31` `tryEmit`): unchanged. `tryEmit` checks
  `emitted.has` **before** the cap (`:17` then `:22`), so pruned visits would have been
  rejected before the cap check; the cap fires at the same emit, or not at all.

**The equivalence argument this part must not break** (design D1, restated so the
implementer can check their own diff against it): let *S* be the sequence of `emit`
calls that pass `tryEmit` today. A pruned subtree contributes nothing to *S* today —
if *T* ∈ `emitted`, every descendant is already in `emitted ∪ marked` and every emit
for it is rejected; if *T* ∈ `marked`, `markTree` (`closure-not-marks.ts:52-76`) marked
every non-gitlink descendant, so each is `continue`d at `:132`. `walkTree` is a
pre-order DFS, so a skipped subtree is a **contiguous** run; deleting a contiguous run
that produces no surviving emit leaves every surviving entry's **ordinal** unchanged.
`path`/`nameHash` are fixed at first encounter and pruning removes only later
encounters. `buildPack` orders by `(type, nameHash, size, recency, oid)`
(`build-pack.ts:53-62`), `pack-objects.ts:82-89` passes `closure.objects` in emission
order, `gc-pipeline.ts:316-335` derives recency from the emission ordinal ⇒ same input
to the packer ⇒ identical bytes and identical `pack.sha`.

**Pinned behaviour — Pin P1** (git 2.55.0; 4 commits: c0 adds `a/{one,two}`, `b/one`;
c1 edits `a/one`; c2 adds `b/two`; c3 empty). tsgit's emitted sequence today, which the
prune must reproduce **exactly** (id, type, path):

```
6cfc0592 commit · 372ae389 tree "" · 636c8321 tree a · 1cfc4dc0 blob a/one · c1827f07 blob a/two ·
e5d9693f tree b · c9c6af7f blob b/one · e6bfff5c blob b/two · db9b60f9 commit · ff0cd82d commit ·
5c6c2f92 tree "" · ada2bddb tree b · 1fca2c18 commit · 96f2db6c tree "" · 8cca9a1d tree a ·
da0f8ed9 blob a/one
```

Under the prune: c2's root `372ae389` is already emitted (short-circuit); in c1's root
the entry `a` = `636c8321` is skipped while `b` = `ada2bddb` is entered and `b/one` is
rejected; in c0's root `a` = `8cca9a1d` is entered and `b` = `e5d9693f` is skipped.
16 objects: 4 commits, 7 trees, 5 blobs. **Pin P4**: for `c3 = commit --allow-empty` on
c2, `rev-parse HEAD~1^{tree}` = `rev-parse HEAD^{tree}` and that oid appears **once** in
`git rev-list --objects HEAD`. With a `not` side (`HEAD ^HEAD~2`) git emits
`6cfc0592 db9b60f9 372ae389 "" e5d9693f b e6bfff5c b/two` — the over-report shape
ADR-618 documents.

**Tests to extend**
- `test/unit/application/primitives/walk-tree.test.ts` (910 lines).
- `test/unit/application/primitives/internal/closure-engine.test.ts` (1594 lines). Local
  helpers `writeBlob`/`writeCommit`/`buildDeepTree` at `:60-90`. The
  `TREE_DEPTH_EXCEEDED` block around `:706-800` uses
  `seedMaxTreeDepth(ctx, '4')` at `:711` (`test/unit/application/primitives/fixtures.ts:43`,
  writes `[core]\n\tmaxTreeDepth = <value>\n` and invalidates the config cache) — those
  tests stay as they are and must stay green.
- `test/unit/application/primitives/build-pack.test.ts` (931 lines) or
  `test/unit/application/commands/pack-objects.test.ts` (457 lines) for the SHA golden.
- `instrumentedContext(base)` (`fixtures.ts:246`) returns `{ ctx, calls }` where
  `calls()` is a `ReadonlyArray<{ method: string; path: string }>` in call order. Filter
  object reads with `calls().filter(c => c.method === 'read' && c.path.includes('objects/'))`.

**New interop file** — `test/integration/rev-list-objects-interop.test.ts`, small and
separate from the 1787-line `rev-bitmap-closure-interop.test.ts`. Follow that file's
shape: `describe.skipIf(!GIT_AVAILABLE)(...)`, `SETUP_TIMEOUT = 60_000`, one
`beforeAll` per fixture, `afterAll` removing the temp dirs. Helpers in
`test/integration/interop-helpers.ts`: `git(dir, ...args)` (`:200`), `runGit` (`:91`),
`runGitEnv()` (`:105`), `tryRunGitWithExit` (`:257`), `GIT_AVAILABLE` (`:149`). Repo
init pattern (copied from `bisect-midpoint-interop.test.ts:35-42`):

```ts
const dir = await mkdtemp(path.join(os.tmpdir(), `tsgit-<slug>-`));
git(dir, 'init', '-q', '-b', 'main');
git(dir, 'config', 'user.name', 'A U Thor');
git(dir, 'config', 'user.email', 'author@example.com');
git(dir, 'config', 'commit.gpgsign', 'false');
```

**Build a fresh tsgit `Context` AFTER every git write** — the graph and fanout caches
are per session.

**`Stryker disable` comments inside touched structures.** None sit in
`walk-tree.ts` or in `emitTree`. `closure-not-marks.ts:63` (abort guard in `markTree`)
is in an untouched structure — leave it, and confirm it still holds after the run.

**Perf oracles (recorded, not asserted in CI).** After GREEN:

```bash
npm run build:profile                     # dist-profile/esm/index.node.js
mkdir -p /private/tmp/p2-oracle && cd /private/tmp/p2-oracle
# write fs-count.cjs and closure-oracle.mjs verbatim from the design's brief
TSGIT_ROOT=/Users/scolladon/workspace/perso/node/tsgit-closure-history-walks \
  node --require ./fs-count.cjs closure-oracle.mjs
```
`fs-count.cjs` wraps `fs.promises.{stat,lstat,readFile,readdir,open,readlink,realpath}`
with a counter and calls `require('node:module').syncBuiltinESMExports()`;
`closure-oracle.mjs` opens `~/.cache/tsgit-bench/medium-v3` (5 000 commits, head
`87723053c29f07c840c0d69d2c60ac7d7f0b4407`) with
`openRepository({ cwd, env: { HOME: os.tmpdir()+'/tsgit-no-home', GIT_CONFIG_NOSYSTEM: '1' }, deltaCacheMaxBytes: 256*1024*1024 })`
and times two iterations of `repo.revList({ wants: [meta.headCommitId], objects: true })`.
**Baseline on this machine: iteration 1 39 298 ms, iteration 2 38 505 ms, `stat=10010`.**
Target: **well under 1 s** (expect ~0.2 s) and `stat` O(1) (the two
`resolveMaxTreeDepth` reads plus the command gate's, not 10 010). Report both numbers.

Also re-run `npx vitest bench --run --config vitest.bench.config.ts test/bench/closure-wide-tree.bench.ts` and
`npx vitest bench --run --config vitest.bench.config.ts test/bench/closure.bench.ts` and report the "after" medians against
Part 1's recorded "before" column (PC-1). Expected on the 300-commit wide-tree row:
≈ 10–20× lower. Both rows still scale ≈ 3× from 100 to 300 commits — linear, not flat.

### TDD steps

1. **CHARACTERIZE FIRST (the "captured on main" step).** Before touching any `src/`
   file, confirm `git status --short` shows no `src/` modification, then write two
   characterization tests against the **current** code and record their literals:
   - `closure-engine.test.ts`: build the Pin P1 shared-subtree repository in memory
     (c0 adds `a/one`, `a/two`, `b/one`; c1 edits `a/one`; c2 adds `b/two`; c3 is an
     empty commit reusing c2's tree). Run
     `computeClosure(ctx, { wants: [c3], not: [], objects: true, tier: 'walk' })` and
     assert the **exact ordered list** of `{ id, type, path, nameHash }`. Write the
     assertion with a placeholder, run it, copy the observed value out of the failure
     message, substitute, re-run → **green on the unchanged tree**. This is legitimate
     precisely because `src/` is unmodified at this moment; verify that again with
     `git status --short` before recording.
   - `build-pack.test.ts` (or `pack-objects.test.ts`): over the same fixture,
     `buildPack(ctx, { objects: closure.objects.map(o => ({ id: o.id, nameHash: o.nameHash })), delta: true })`
     — mirror the existing call shape in that file — and assert `result.sha` equals the
     recorded literal. Same placeholder-then-substitute procedure.
   - Put **both literals in the part's final message.** They are the pack-byte pin.
2. **RECORD the delta-chain pack SHA from the unchanged tree.** Still before any `src/`
   edit: `npm run build:profile`, then a scratch script under
   `/private/tmp/p2-delta-chain/` that opens `~/.cache/tsgit-bench/delta-chain-v3`
   (head `d7d646be0ae5201e22660a0038f3057c0b08e5ae`, **read-only** — never write into
   the cache) and runs
   `repo.packObjects({ wants: [head], outputDirectory: <a mktemp -d>, useBitmapIndex: false })`.
   **`useBitmapIndex: false` is mandatory**: the option defaults to `true`, and although
   this fixture carries no `.bitmap` today, letting the bitmap tier answer would make the
   byte-identity check vacuous — the walk tier is the code this part changes. Record
   `result.packId` and `shasum -a 256 <out>/pack-*.pack`. Re-check both after GREEN.
   Report both values in the final message.
3. **RED — `skipTree` is evaluated once per directory entry, before the yield.**
   `walk-tree.test.ts`: a predicate that records its calls and a consumer that mutates a
   set on each yield. Assert (i) the predicate is called exactly once per **directory**
   entry with that entry's id, (ii) it is **not** called for blob or gitlink entries,
   (iii) the consumer's yield-time mutation does not change any verdict. Expected
   failure: `skipTree` is not a member of `WalkTreeOptions` (type error), then
   "predicate never called".
4. **RED — a `true` verdict yields the entry but does not enter the subtree.**
   `walk-tree.test.ts` with `instrumentedContext`: the directory entry is still yielded,
   and there is **no** `read` of the subtree's object path. Expected failure: the subtree
   is read and its entries are yielded.
5. **RED — the counter counts visited entries.** `walk-tree.test.ts`: with a `skipTree`
   that prunes one subtree, a `maxEntries` set just above the *visited* count completes
   where the unpruned walk would refuse `TREE_ENTRY_LIMIT_EXCEEDED`. Assert the error
   `.data` (code, `count`, `limit`) on the unpruned arm.
6. **RED — the closure prunes marked and emitted subtrees.** `closure-engine.test.ts`:
   (i) a `not`-marked subtree is **not** descended (read count on `instrumentedContext`);
   (ii) a root tree already emitted by an earlier commit causes **no** walk at all
   (read count); (iii) the characterization list from step 1 is unchanged.
   Expected failure: the read counts are the unpruned ones.
7. **RED — the cap still fires at the same emit.** `closure-engine.test.ts`: an
   `EmitState` cap small enough to trip `PACK_TOO_LARGE` mid-closure; assert `.data`
   (`code`, `objectCount`, `limit`) is identical with and without the prune's fixture
   shape.
8. **RED — one config resolution per closure.** `closure-engine.test.ts`: spy
   `resolveMaxTreeDepth` (or count `read`s of `.git/config` through
   `instrumentedContext`) over a closure spanning N commits; assert the resolution
   happens **exactly once**. Expected failure: N + 1 resolutions.
9. **GREEN** — implement, in this order: `types.ts` member → `walk-tree.ts`
   `WalkConfig`/`FrameStep`/`nextFrameEntry`/loop → `closure-engine.ts` `TreeEmitScope`,
   `emitTree`, `resolveWants` parameter, `walkClosure` scope construction, three call
   sites, `maxDepth: scope.maxDepth`.
10. **RED → GREEN — interop.** New `test/integration/rev-list-objects-interop.test.ts`:
    `beforeAll` builds the P1 repository with real `git` (`git init -q -b main`, the
    three config lines, then `git add`/`git commit` for c0…c2 and
    `git commit --allow-empty` for c3, deterministic `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`
    through `runGitEnv`). Rows: (i) `revList({ wants:['HEAD'], objects:true })` id set
    equals `git rev-list --objects HEAD | cut -d' ' -f1 | sort`; (ii) the identical-tree
    commit's root oid appears exactly once in tsgit's entries (P4); (iii)
    `revList({ wants:['HEAD'], not:['HEAD~2'], objects:true })` id set equals
    `git rev-list --objects HEAD ^HEAD~2`'s. Build a **fresh** `Context` after the git
    writes.
11. **REFACTOR** — keep `nextFrameEntry` under 20 lines (extract the descend expression
    if needed); no comment restates what the code says.
12. **Surface gate** — `npm run docs:json`; `git diff --stat -- reports/api.json` is
    non-empty (`skipTree` is public); commit it with the part.
13. **Perf oracle** — run the closure oracle and the two bench files; report the numbers.

### Gate

```
npx vitest run test/unit/application/primitives/walk-tree.test.ts test/unit/application/primitives/internal/closure-engine.test.ts test/unit/application/primitives/build-pack.test.ts test/unit/application/commands/pack-objects.test.ts 2>&1 | tee /tmp/p2-vitest.log; echo $?
npx vitest run test/integration/rev-list-objects-interop.test.ts 2>&1 | tee /tmp/p2-interop.log; echo $?
npm run check:types 2>&1 | tee /tmp/p2-types.log; echo $?
npx tsc --noEmit -p tsconfig.json 2>&1 | tee /tmp/p2-tsc.log; echo $?
./node_modules/.bin/biome check src/application/primitives/types.ts src/application/primitives/walk-tree.ts src/application/primitives/internal/closure-engine.ts test/unit/application/primitives/walk-tree.test.ts test/unit/application/primitives/internal/closure-engine.test.ts test/integration/rev-list-objects-interop.test.ts 2>&1 | tee /tmp/p2-biome.log; echo $?
npm run check:spelling 2>&1 | tee /tmp/p2-spell.log; echo $?
npm run docs:json 2>&1 | tee /tmp/p2-docs-json.log; echo $?; git diff --stat -- reports/api.json
```

### Commit

```
perf(closure): expand each distinct tree once and resolve the depth cap per closure
```

## Part 3 — `push` computes its object set through the shared closure

### Context

Depends on Part 2 (push inherits the prune). Today `push` runs its own weaker
enumerator: every tree and blob reachable from the wanted commits, with **no** not-side
tree marking, so a one-file push on a 20 000-file tree sends the whole tree.

**Mechanism (git).** `send-pack.c:45-55` `feed_object(r, oid, fh, negative)`:
`if (negative && !odb_has_object(r->objects, oid, 0)) return;` — a negative oid the
local repository does not hold is dropped before it reaches `pack-objects`. Callers
(`:104-112`) feed each remote ref's `old_oid` negative and each `new_oid` positive.
`pack-objects --revs` then computes the closure with the bitmap when one is usable
(ADR-843).

**Files and exact anchors**

`src/application/commands/push.ts` (543 lines)
- `:53` `import { enumeratePushObjects } from '../primitives/enumerate-push-objects.js';`
  — **remove**.
- `:346-353` in `sendUpdates`:

```ts
346:  const wants = movers.filter((m) => !m.parsed.isDelete).map((m) => m.localOid);
347:  // Zero-oid-advertised refs (ref-creation sentinels) are kept verbatim in
348:  // `haves`: they only ever land in `walkCommits`'s `until` set, which does
349:  // pure membership checks and can never match a real commit oid — so an
350:  // explicit `id !== zeroOid(ctx.hashConfig)` filter would be a provable no-op.
351:  const haves = adv.refs.map((r) => r.id);
352:  const oids = await collectObjects(ctx, wants, haves);
353:  const pack = await buildPack(ctx, { objects: oids.map((id) => ({ id })) });
```

  The comment at `:347-350` **must be rewritten**: its justification ("they only ever
  land in `walkCommits`'s `until` set") is false after this change. The *outcome* is
  unchanged — `hasObject(ctx, zeroOid)` is `false` (no pack hit, no loose file) — so the
  sentinel still drops out, but now as one absent negative among others. Say that.
- `collectObjects` `:453-464` (the whole body is replaced; keep the `wants.length === 0`
  early return at `:458` verbatim):

```ts
const collectObjects = async (
  ctx: Context,
  wants: ReadonlyArray<ObjectId>,
  haves: ReadonlyArray<ObjectId>,
): Promise<ReadonlyArray<ObjectId>> => {
  if (wants.length === 0) return [];
  const distinctHaves = [...new Set(haves)];
  // git's send-pack feed_object: a negative we do not hold locally is never fed.
  const present = await boundedMapFor(ctx, 'ioBound', distinctHaves, (id) => hasObject(ctx, id));
  const not = distinctHaves.filter((_, index) => present[index] === true);
  const closure = await computeClosure(ctx, { wants, not, objects: true, tier: 'bitmap' });
  return closure.objects.map((object) => object.id);
};
```

- New imports: `hasObject` from `../primitives/has-object.js`, `boundedMapFor` from
  `../primitives/internal/concurrency.js`, `computeClosure` from
  `../primitives/internal/closure-engine.js`. A Tier-1 command importing
  `primitives/internal/` is **already the house pattern** — `range-diff.ts:22` imports
  `boundedMapFor` from exactly that path — so `check:architecture` (dep-cruiser) has no
  new edge to complain about. Verify with `npm run check:architecture`.
- `buildPack(ctx, { objects: oids.map((id) => ({ id })) })` at `:353` is **unchanged**:
  no `nameHash`, no `recency`, no `delta` — those belong to a later item.
- `MAX_PUSH_OBJECTS` is not referenced in `push.ts`. The cap moves from
  `enumeratePushObjects`' own `EmitState` to the closure engine's
  (`closure-engine.ts:245`, `cap: MAX_PUSH_OBJECTS`) — same constant, same
  `PACK_TOO_LARGE` error.

`src/application/primitives/has-object.ts` (17 lines, whole file):

```ts
export const hasObject = async (ctx: Context, id: ObjectId): Promise<boolean> => {
  const hit = await getPackRegistry(ctx).lookup(id);
  if (hit !== undefined) return true;
  return ctx.fs.exists(looseObjectPath(commonGitDir(ctx), id));
};
```
It never consults `ctx.promisor`, so a promised-but-absent object answers `false` —
matching git's `odb_has_object(…, 0)`, which does not fetch either.

`boundedMapFor` (`internal/concurrency.ts:53-58`):
`<T,R>(ctx, bucket: 'cpuBound'|'ioBound', items: ReadonlyArray<T>, worker: (item: T) => Promise<R>) => Promise<R[]>`,
input-order preserving.

**Observable change (git-faithful).** The pushed set shrinks from "everything reachable
from the wants" to `wants AND NOT haves`. Order of the survivors is the closure's — the
same per-commit shape (commit, its tree, its entries). The cost moves: `markNotSide`
walks the haves' full commit ancestry (tsgit's not-side walk is total where git's is
slop-limited — pre-existing, documented in `closure-not-marks.ts`'s module doc), which
on the medium fixture is one commits-only walk against today's full-tree walk **per
pushed commit**.

**`enumeratePushObjects` stays.** It keeps its barrel export
(`primitives/index.ts:45`), its `EnumeratePushObjectsInput` type export (`:44`), its
unit test (`test/unit/application/primitives/enumerate-push-objects.test.ts`), its
api-surface pins (`test/unit/api-surface/primitives-binding-surface.test.ts:57`,
`test/unit/application/primitives/index.test.ts:26,124`) and its direct interop callers
(`test/integration/shallow-walk-interop.test.ts:22,489-496,699-715`). None of those
change. Its deletion belongs to a later item.

**`test/unit/application/commands/push.test.ts` — the full sweep (2533 lines, 70 `it`
+ one 4-param `it.each`).** Every test drives `push()` end to end against a real
`createMemoryContext()`; **none** mocks `enumeratePushObjects`, `hasObject`,
`computeClosure` or `boundedMapFor`. The fake advertisement builder is
`buildAdvertisementBytes(refs, caps)` at **`:71-95`** (not `:59-80`); with
`refs.length === 0` it emits the all-zero-oid `capabilities^{}` sentinel — the exact
ref-creation sentinel the filter must drop.

Case-by-case verdict:

| Line(s) | Group | Verdict |
|---|---|---|
| 221 (`it.each`×4), 254, 330, 360, 390, 422, 449, 481, 511 | config guards | **UNCHANGED** — every one throws before any refspec/object resolution. |
| 537 | happy path, no refspec | **UNCHANGED** — asserts `remote`/`url`/`pushedRefs`, not the object set. |
| 569 | local matches remote | **UNCHANGED** — `movers.length === 0` short-circuits before `collectObjects` runs. |
| 595 (assertion at **618**: `expect(captured[0]).toStrictEqual({ id: tip.id })`, with `:615` `toHaveBeenCalledTimes(1)` and `:617` `toBeGreaterThan(0)`) | buildPack shape | **UNCHANGED** — shape-only, and `closure.objects[0]` is still the tip commit (`resolveWants` peels, then `walkAndEmitCommits` emits the commit first). The spy is `vi.spyOn(buildPackMod, 'buildPack')` over `import * as buildPackMod from '…/build-pack.js'` (`:26`, `:609`). |
| 628 | object format | **UNCHANGED** — throws before pack build. |
| 668, 727, 758 | server responses | **UNCHANGED**. |
| 792, 822, 846, 876, 905, 953, 982, 1017 | force / non-FF / force-with-lease | **UNCHANGED** — those guards fire in `resolveAllRefspecs` (`push.ts:184-189`, throw at `:292`), before `sendUpdates`. |
| 1058, 1086, 1120, 1157 | delete refspec | **UNCHANGED** — delete-only gives `wants = []`, which hits the preserved early return. |
| 1188, 1214, 1278, 1298, 1326 | side-band, tracking cache | **UNCHANGED**. |
| 1356, 1378, 1406 | progress | **UNCHANGED** — `PUSH_ENUMERATE_OBJECTS_OP` brackets the whole exported `push()` (`push.ts:143-148`), not `collectObjects`. |
| 1431, 1463, 1491, 1519, 1548, 1577 | auth/signal/headers/empty refspecs | **UNCHANGED**. |
| **1606** | matching mode (two advertised local heads in one call) | **UNCHANGED assertion; NEEDS A SIBLING** — the only multi-`want` fixture in the file and it never inspects the pack. Add one assertion that a single `collectObjects` call over two disjoint tips with two real negatives produces the union of both closures. |
| **1659** | pack contents — "tip closure excludes parent", `packObjectCount(body) === 3` | **UNCHANGED numerically** — `parent`/`tip` carry distinct blob content, so the old `until: haves` commit boundary already excluded parent's commit+tree+blob. The mechanism changes (commit boundary → real negative-closure subtraction) but the count does not, because **no test in this file gives two commits a shared subtree oid**. |
| 1694 | non-FF with a missing ancestor | **UNCHANGED** — the guard fires before `sendUpdates`, so `hasObject` never sees `missingParentId`. |
| 1731, 1762, 1795 | URL composition, tag tracking | **UNCHANGED**. |
| 1864–2350 (signed push: 1864, 1901, 1930, 1953, 1978, 2003, 2024, 2052, 2075, 2098, 2148×2, 2174, 2201, 2228, 2256, 2285, 2320, 2350) | signed push | **UNCHANGED** — the certificate is built from `movers`/`updates`, never from `oids`. |
| 2374, 2412, 2436, 2480, 2509 | hooks | **UNCHANGED** — `runPrePushHook` precedes `sendUpdates` (`push.ts:186-189`). |

**Coverage gap this part must close:** of 74 cases, exactly two touch the object set,
and **zero** exercise the behaviour the change exists for. Three new cases are owed
(TDD steps 1–3 below).

**Interop** — extend `test/integration/network/push-http-backend.test.ts` (1571 lines).
`beforeAll` (`:171-196`, 60 s) copies `FIXTURE_DIR/source.git` into a temp dir, enables
`http.receivepack` / `receive.denyCurrentBranch=updateInstead`, and starts a real
`node:http` server shelling out to `git-http-backend`. Pushes run through
`repo.push({ remote: 'origin', refspecs: ['refs/heads/main:refs/heads/main'] })`
(`:274`) after a `clone`. Refs are asserted via `result.pushedRefs`,
`runGit(['-C', bareRepoPath, 'rev-parse', 'main'])` and the local
`refs/remotes/origin/main` cache. **This suite spawns git through an in-process HTTP
server — use the async runner (`gitAsync`/`runGitAsync`) for anything long-running; a
synchronous `git` call blocks the server and deadlocks the test.**

**`Stryker disable` comments in touched structures.** `enumerate-push-objects.ts:69`
(`ObjectLiteral`, `walkTree` options) sits in a file this part does not touch — leave it.

### TDD steps

1. **RED — a have's shared content is not resent.** `push.test.ts`, new case under the
   pack-contents describe: build `g0` (a two-file tree), `g1` on top of `g0` changing
   only file A (so file B's blob and, if nested, its subtree are **shared**), and `tip`
   on top of `g1` changing only file A again. Advertise `g0` as the remote tip and push
   `tip`. Assert the pushed oid set (via the `buildPack` spy's captured `objects`, the
   same `vi.spyOn(buildPackMod, 'buildPack')` pattern as `:609`) **excludes** file B's
   blob. Expected failure today: `enumeratePushObjects` sends it again, because the haves'
   object closure is never subtracted.
2. **RED — an advertised tip the repository does not hold is dropped, not refused.**
   `push.test.ts`: advertise a syntactically valid but locally absent oid alongside a
   real one. Assert the push succeeds and the closure's negatives are the present ones
   only. Expected failure: `markNotSide` `readObject`s the absent have and throws
   `OBJECT_NOT_FOUND` (assert `.data.code`).
3. **RED — the zero-oid ref-creation sentinel is dropped.** `push.test.ts`: use the
   `refs.length === 0` advertisement (the `capabilities^{}` sentinel) so `haves` is
   `[ZERO_OID]`. Assert the push succeeds and the pushed set is the full closure of the
   wants. Trigger this condition **alone**, separately from case 2 — the filter is one
   predicate over two independently-reachable inputs and each needs its own row.
4. **RED — the tier is the bitmap.** `push.test.ts`: spy `computeClosure` with a
   delegating spy so real behaviour is preserved —
   `import * as closureMod from '…/internal/closure-engine.js'; const sut = vi.spyOn(closureMod, 'computeClosure');`
   mirroring the `buildPackMod` pattern at `:26`/`:609` — and assert the captured first
   argument object contains `objects: true` and `tier: 'bitmap'`, and that `not` is
   exactly the locally-present advertised oids. **A unit-level spy on the captured
   argument is required**: the mutation config is unit-only and cannot see a
   tier choice that is otherwise observable only through a real bitmap.
5. **RED — the multi-want sibling.** Extend the matching-mode case at `:1606` with an
   assertion that the single `collectObjects` call over two disjoint tips returns the
   union of both closures.
6. **GREEN** — replace `collectObjects`, rewrite the `:347-350` comment, fix the
   imports, drop the `enumeratePushObjects` import.
7. **RED → GREEN — interop.** Extend `push-http-backend.test.ts`: after cloning, create
   one new commit on top of the shared history that changes exactly one file, push it,
   then assert `git -C <bare> rev-list --objects --all` grew by **exactly** the new
   commit, its root tree, the changed subtree (if the file is nested) and the changed
   blob — i.e. git's own minimal pack. Capture the `--objects` set before and after and
   diff the two.
8. **REFACTOR** — `collectObjects` stays under 20 lines; the `present`/`not` pair reads
   as one filter.
9. **Surface gates** — `npm run check:architecture` (the `primitives/internal/` import
   edge); `npm run docs:json` + `git diff --stat -- reports/api.json` (expected empty —
   no public symbol changed; commit it if not).

### Gate

```
npx vitest run test/unit/application/commands/push.test.ts test/unit/application/primitives/enumerate-push-objects.test.ts 2>&1 | tee /tmp/p3-vitest.log; echo $?
npx vitest run test/integration/network/push-http-backend.test.ts 2>&1 | tee /tmp/p3-interop.log; echo $?
npm run check:types 2>&1 | tee /tmp/p3-types.log; echo $?
npx tsc --noEmit -p tsconfig.json 2>&1 | tee /tmp/p3-tsc.log; echo $?
npm run check:architecture 2>&1 | tee /tmp/p3-arch.log; echo $?
./node_modules/.bin/biome check src/application/commands/push.ts test/unit/application/commands/push.test.ts test/integration/network/push-http-backend.test.ts 2>&1 | tee /tmp/p3-biome.log; echo $?
npm run check:spelling 2>&1 | tee /tmp/p3-spell.log; echo $?
npm run docs:json 2>&1 | tee /tmp/p3-docs-json.log; echo $?; git diff --stat -- reports/api.json
```

### Commit

```
perf(push): send git's minimal pack by computing the closure with real negatives
```

## Part 4 — `walkCommits` drains its frontier with a head cursor

### Context

Independent of Parts 2, 3 and 5 — reorderable anywhere after Part 1.
`walk-commits.ts:110` drains the frontier with `queue.shift()`, the O(n²) that
`bitmap-binding.ts:204-210` was already fixed for; that file is the house pattern.

**File and exact anchors** — `src/application/primitives/walk-commits.ts` (159 lines)
- `interface WalkState` `:18-27`. The comment at `:19-21` ("queue is mutated in-place
  via push/shift; declared without `readonly` to signal that intent honestly") **must be
  rewritten for the cursor**. Add `head: number` (also non-`readonly`, same honesty
  rule). `until: Set<ObjectId>` at `:25` is Part 5's business, not this part's.
- `createWalkSession` `:39-60`: `queue: [...options.from]` at `:45`; initialise
  `head: 0`. The seed priming loop at `:58` (`for (const seed of state.queue) bodies.start(seed);`)
  is unchanged.
- `walkCommits` loop `:107-122`:
  `while (state.queue.length > 0)` at `:107` becomes `while (state.head < state.queue.length)`;
  `const id = state.queue.shift() as ObjectId;` at `:110` becomes
  `const id = state.queue[state.head]!; state.head += 1;` (the `as ObjectId` cast and the
  "Caller guards `queue.length > 0`" comment at `:109` go with it).
- `enqueueIds` `:150-158`: `if (state.queue.length >= MAX_WALK_QUEUE_SIZE)` at `:153`
  becomes `if (state.queue.length - state.head >= MAX_WALK_QUEUE_SIZE)`. `MAX_WALK_QUEUE_SIZE = MAX_WALK_SEEDS * 64 = 65 536`
  (`types.ts:27,30`). `REASON_WALK_QUEUE_OVERFLOW` and `invalidWalkInput` are unchanged.
- Memory: the retained array grows to the number of ids ever enqueued. `state.visited`
  already retains that order of memory, so this adds no new class of growth.

**The three existing overflow tests must stay green, and they do.**
`test/unit/application/primitives/walk-commits.test.ts:603-760`, block
`describe('queue-overflow guard')`. Worked through against the cursor so the
implementer does not have to:
- `:604-642` — one seed with `MAX+1 = 65 537` distinct parents. After the pop `head = 1`,
  so the guard fires one push later than today (at pending 65 536, i.e. array length
  65 537). There are 65 537 parents to push, so it **still throws** `INVALID_WALK_INPUT`
  with the queue reason.
- `:644-679` — `MAX+1` parents that are all one already-visited oid; the dedup pre-filter
  skips every one, no overflow either way. Unchanged.
- `:681-759` — `filler` (65 500 distinct never-read parents) then graph-covered `head`
  (30 real parents), walked from `[filler, head]`. After two pops `head = 2`, so pending
  runs 65 500 → 65 530 on the correct single header-enqueue (< 65 536, no overflow, the
  abort at `:742` is the walk's next stop) and 65 530 → 65 560 on the mutant's redundant
  second enqueue (crosses 65 536 → `INVALID_WALK_INPUT`). **The mutant is still killed**,
  with a 6-push margin instead of today's 4. Do not retune the constants.
- Fixture helpers in that file: `buildSeededContext` (`fixtures.ts:156`), `linearChain`,
  `asCommits`, `buildDiamond` (`:28-76` of the test file), `collect`, `AUTHOR`,
  `writeCommitGraph(ctx, layers)` (`fixtures.ts:414` — the **fixture** helper taking
  `(ctx, ReadonlyArray<ReadonlyArray<Commit>>)`, NOT the production primitive of the
  same name in `src/application/primitives/write-commit-graph.ts`).

**The new pin — the bound is on the pending count, not the array length.** With `k`
pops already done, the old rule fires at `queue.length ≥ 65 536` (i.e. pending
`≥ 65 536 − k`) and the new rule at pending `≥ 65 536`. So a walk that pops `k = 2`
commits and then meets an octopus with **`MAX_WALK_QUEUE_SIZE − 1 = 65 535`** fresh
parents overflows under the old rule and must **not** overflow under the cursor; the
same walk with **`MAX_WALK_QUEUE_SIZE + 1 = 65 537`** fresh parents must still overflow.
Build it as `from: [a, b]` where `a` is a parentless root and `b` is the octopus, with
`ignoreMissing: true` so the fake parent oids drain quietly. That arm performs ~65 k
missing-object probes on the memory adapter — the same order of work the existing `:604`
test already does — so expect it to be the slowest case in the file, not a hang.

**No `Stryker disable` comment lives in this file.** Any equivalence claim about the
new bound must be killed by the two tests above, never suppressed.

### TDD steps

1. **RED — `k > 0` pops must not overflow at `MAX − 1` fresh parents.**
   `walk-commits.test.ts`, a fourth case in the `queue-overflow guard` block:
   `from: [root, octopus]` with `ignoreMissing: true`, `octopus` carrying 65 535 fresh
   distinct fake parent oids. Assert the walk completes yielding exactly `[root, octopus]`
   and throws nothing. Expected failure today: `INVALID_WALK_INPUT` with the
   queue-overflow reason (assert `.data.code` and `.data.reason` on the current run so
   the red is specific).
2. **RED — `k > 0` pops still overflow at `MAX + 1`.** Same shape with 65 537 parents;
   assert `INVALID_WALK_INPUT` and `.data.reason` containing `queue`. This arm is green
   today and must stay green — it is the guard against a "cursor forgot the bound at
   all" mutant.
3. **GREEN** — add `head`, change the loop condition and the pop, change the
   `enqueueIds` bound, rewrite the `:19-21` comment.
4. **VERIFY** — run the whole `walk-commits.test.ts` file; the three pre-existing
   overflow tests must be green **without edits**. If any needs an edit, stop and
   escalate `{ part, reason, ≤3 options }` — an edit there means the bound moved further
   than the analysis above predicts.
5. **REFACTOR** — the loop body stays flat; no new helper is warranted.
6. **Surface gate** — `npm run docs:json` + `git diff --stat -- reports/api.json`
   (expected empty).

### Gate

```
npx vitest run test/unit/application/primitives/walk-commits.test.ts 2>&1 | tee /tmp/p4-vitest.log; echo $?
npm run check:types 2>&1 | tee /tmp/p4-types.log; echo $?
npx tsc --noEmit -p tsconfig.json 2>&1 | tee /tmp/p4-tsc.log; echo $?
./node_modules/.bin/biome check src/application/primitives/walk-commits.ts test/unit/application/primitives/walk-commits.test.ts 2>&1 | tee /tmp/p4-biome.log; echo $?
npm run check:spelling 2>&1 | tee /tmp/p4-spell.log; echo $?
npm run docs:json 2>&1 | tee /tmp/p4-docs-json.log; echo $?; git diff --stat -- reports/api.json
```

### Commit

```
perf(walk-commits): drain the frontier with a head cursor instead of shift
```

## Part 5 — `until` accepts a set, and the closure buffers only what it needs

### Context

Runs **after Part 2** (both touch `closure-engine.ts`; this part rewrites
`walkAndEmitCommits`'s buffer while Part 2 rewrote `emitTree`). ADR-838 widens both
public commit walks' `until`; the closure stops buffering whole `Commit` bodies.

**Public surface** — `WalkCommitsOptions.until` and `WalkCommitsByDateOptions.until`
both widen to `ReadonlyArray<ObjectId> | ReadonlySet<ObjectId>`. Non-breaking.
`reports/api.json` regeneration is **owed by this part** (prepush gate).

**Files and exact anchors**

`src/application/primitives/types.ts`
- `WalkCommitsOptions` `:121-140`, member `until` at `:123`.
- `WalkCommitsByDateOptions` `:148-164`, member `until` at `:150`.

`src/application/primitives/internal/` — one shared narrowing helper (new small module,
internal, imported by path; a natural home is next to `bounded-reader.ts`):

```ts
const EMPTY: ReadonlySet<ObjectId> = new Set();

/** The set a walk should test membership against: the caller's own set by
 *  reference, or one built from an array. Never copies a set. */
export const asIdSet = (until: ReadonlyArray<ObjectId> | ReadonlySet<ObjectId> | undefined):
  ReadonlySet<ObjectId> =>
    until === undefined ? EMPTY : (typeof (until as ReadonlySet<ObjectId>).has === 'function'
      ? (until as ReadonlySet<ObjectId>)
      : new Set(until as ReadonlyArray<ObjectId>));
```

Three branches, three test rows (array, set by reference, `undefined`) — the coverage
gate needs each.

`src/application/primitives/walk-commits.ts`
- `WalkState.until` `:25` becomes `ReadonlySet<ObjectId>` (it is only ever `.has`-read,
  at `:111` and `:152`).
- `createWalkSession` `:48` `until: new Set(options.until ?? [])` becomes
  `until: asIdSet(options.until)`.

`src/application/primitives/internal/commit-date-walk.ts`
- `CommitDateWalkOptions.until` `:31` widens the same way.
- `DateWalk.until` `:50` becomes `ReadonlySet<ObjectId>` (read at `:130` and `:147`).
- `:96` `until: new Set<ObjectId>(options.until ?? [])` becomes `until: asIdSet(options.until)`.

`src/application/primitives/internal/closure-engine.ts`
- `walkAndEmitCommits` `:204-228`: `const walked: Commit[] = []` at `:211`,
  `walked.push(commit)` at `:218`, `until: [...marks.commits]` at `:214`,
  `markBoundaryTrees(ctx, walked, marks)` at `:222`, and the emit loop at `:224-227`.
  Replace with:

```ts
interface WalkedCommit {
  readonly id: ObjectId;
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
}
const walked: WalkedCommit[] = [];
for await (const commit of walkCommits(ctx, {
  from: commitSeeds.map((seed) => seed.id),
  until: marks.commits,                 // the set itself — markNotSide completed first
  ignoreMissing: true,
  order: request.firstParent === true ? 'first-parent' : 'topo',
})) {
  walked.push({ id: commit.id, tree: commit.data.tree, parents: commit.data.parents });
  if (request.maxCount !== undefined && walked.length >= request.maxCount) break;
}
```

  The emit loop then reads `commit.id` and `commit.tree` (no `.data`). Commit bodies
  (message, author, committer, signature) are released as the walk proceeds.

`src/application/primitives/internal/closure-not-marks.ts`
- `markBoundaryTrees` `:175-191` — its `walked` parameter becomes
  `ReadonlyArray<WalkedCommit>`. It reads `commit.data.parents` at `:182`; that becomes
  `commit.parents`. **Design correction 2**: the brief said it reads only `id` and
  `tree`; it also reads `parents`, which is why the buffer is `{ id, tree, parents }`.
  **Declare `WalkedCommit` in `closure-not-marks.ts` and import the type into
  `closure-engine.ts`** — that is the existing dependency direction
  (`closure-engine.ts:33` already imports `NotMarks` and `markBoundaryTrees` from there),
  so it cannot create the import cycle `check:architecture` refuses. Do not duplicate the
  shape.
- `markCommitAncestry` `:100-108`: `until: [...markedCommits]` at `:103` becomes
  `until: markedCommits` (the live `Set` by reference). **The `Stryker disable next-line ArrayDeclaration`
  at `:102` goes away with the array literal** — delete the comment, do not carry it
  forward onto the new expression. Passing the live set is safe: a commit is added to
  `markedCommits` only **after** it has been yielded (`:106`), and a yielded commit is
  already in the walk's `visited`, so `until` membership can no longer change the walk's
  fate.

**Consumer sweep — by VALUE SHAPE, not by name.** The type widens, so `tsc` stays green
whether or not a caller is updated. Verified list of every `until:` in `src/`:

| Site | Today | After |
|---|---|---|
| `closure-engine.ts:214` | `[...marks.commits]` | `marks.commits` |
| `closure-not-marks.ts:103` | `[...markedCommits]` (+ suppression at `:102`) | `markedCommits`; suppression deleted |
| `cherry-pick.ts:145` | `[...excluded]` (`excluded = new Set<ObjectId>()`, `:140`) | `excluded` |
| `revert.ts:334` | `[...excluded]` (`:329`) | `excluded` |
| `rebase.ts:182` | `[...excluded]` (`:171`) | `excluded`. The plain equivalent-mutant note at `:178-181` describes the `until: []` mutant; **re-read it against the reference form** and keep it only if it still reads true. |
| `enumerate-bundle-objects.ts:235` | `[...uninteresting.commits]` | **LEFT AS IS.** Bundle is out of scope (design correction 3). The `Stryker disable` at `:211` quotes that exact expression in its equivalence prose — leaving the call alone leaves that proof intact. |
| `log.ts:57-58`, `whatchanged.ts:50-51`, `shortlog.ts:45`, `range-diff.ts:99`, `enumerate-push-objects.ts:64` | plain arrays | **unchanged** — arrays remain valid. |

**Tests to extend**
- `test/unit/application/primitives/walk-commits.test.ts` (1243 lines).
- `test/unit/application/primitives/walk-commits-by-date.test.ts` (880 lines).
- `test/unit/application/primitives/internal/closure-engine.test.ts` (1594 lines) — the
  existing over-report tests (a boundary a later commit surfaces still gating an earlier
  commit's tree walk) must stay green; they are the proof that `markBoundaryTrees` still
  sees `parents`.

### TDD steps

1. **RED — `until` as a `Set` yields exactly what an array yields.**
   `walk-commits.test.ts` and `walk-commits-by-date.test.ts`: the same fixture walked
   twice, once with `until: [a, b]` and once with `until: new Set([a, b])`; assert the
   yielded id sequences are identical. Expected failure: a type error (the option does
   not accept a set), then a runtime miss.
2. **RED — the set is used by reference, not copied.** Same files: pass a `Set` that is
   still empty when `walkCommits(...)` is called, add an id to it **before** the first
   `next()`, and assert that id is excluded. A copy-on-entry implementation fails this.
   This is the mutation kill for a `new Set(until)` regression.
3. **RED — the closure buffers `{ id, tree, parents }`.**
   `closure-engine.test.ts`: assert `markBoundaryTrees` receives records carrying
   exactly `id`, `tree` and `parents` — spy the callee and assert **key presence** on the
   captured argument (`Object.keys(...)`), because `toEqual` cannot see an extra or a
   missing key on a subset comparison. Expected failure: whole `Commit` objects.
4. **GREEN** — `types.ts` widening → `asIdSet` helper + its own unit rows (array,
   set-by-reference, `undefined`) → `walk-commits.ts` → `commit-date-walk.ts` →
   `closure-engine.ts` buffer → `markBoundaryTrees` signature → the four caller
   rewrites in the sweep table.
5. **VERIFY the sweep** — `command grep -rn "until:" src/` and check every row of the
   table above; `enumerate-bundle-objects.ts:235` must still read `[...uninteresting.commits]`.
6. **REFACTOR** — `asIdSet` has one responsibility and no branch beyond the two shapes;
   the `EMPTY` constant is module-level and frozen.
7. **Surface gate** — `npm run docs:json`; `git diff --stat -- reports/api.json` is
   **non-empty** (`until` is public on two types); commit it with the part.

### Gate

```
npx vitest run test/unit/application/primitives/walk-commits.test.ts test/unit/application/primitives/walk-commits-by-date.test.ts test/unit/application/primitives/internal/commit-date-walk.test.ts test/unit/application/primitives/internal/closure-engine.test.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/revert.test.ts test/unit/application/commands/rebase.test.ts 2>&1 | tee /tmp/p5-vitest.log; echo $?
npm run check:types 2>&1 | tee /tmp/p5-types.log; echo $?
npx tsc --noEmit -p tsconfig.json 2>&1 | tee /tmp/p5-tsc.log; echo $?
./node_modules/.bin/biome check src/application/primitives/types.ts src/application/primitives/walk-commits.ts src/application/primitives/internal/commit-date-walk.ts src/application/primitives/internal/closure-engine.ts src/application/primitives/internal/closure-not-marks.ts src/application/commands/cherry-pick.ts src/application/commands/revert.ts src/application/commands/rebase.ts 2>&1 | tee /tmp/p5-biome.log; echo $?
npm run check:spelling 2>&1 | tee /tmp/p5-spell.log; echo $?
npm run docs:json 2>&1 | tee /tmp/p5-docs-json.log; echo $?; git diff --stat -- reports/api.json
```

### Commit

```
feat(walk-commits): accept a set of boundary commits and stop buffering whole bodies
```

## Part 6 — `readCommitMeta`: the commit-graph serves parents, date and generation

### Context

Prerequisite for Parts 7 and 8. `CommitHeader.generation` is produced
(`read-commit-graph.ts:37`, `:303`) and read by nobody; `merge-base`,
`bisect-midpoint` and `name-rev` each read and parse a **full commit object** for
parents and committer date only, where git's `parse_commit_in_graph` serves both from
the graph with no object read. This part introduces the shared reader and migrates
**bisect-midpoint** onto it; Parts 7 and 8 migrate their own command files so each is
rewritten exactly once.

**Mechanism (git).** `commit-graph.c:126-135` `commit_graph_generation`:
`if (data && data->generation) return data->generation; return GENERATION_NUMBER_INFINITY;`
— infinite both for a commit outside the graph and for a graph that stored `0`
(`commit.h:12-15`: `GENERATION_NUMBER_INFINITY ((1ULL << 63) - 1)`,
`GENERATION_NUMBER_ZERO 0`). ADR-839 maps both onto `Number.POSITIVE_INFINITY`.

**Existing surface this builds on**

`src/application/primitives/internal/read-commit-graph.ts` (317 lines)
- `interface CommitHeader` `:33-38` = `{ rootTree, parents, committerDate, generation }`.
- `commitHeader(ctx, id): Promise<CommitHeader | undefined>` `:286-317` — bounded header
  cache first (`:287-289`), then `loadGraph(ctx)`; `undefined` when the graph is absent
  or does not cover `id`; a parsed-but-inconsistent graph degrades to absent for the rest
  of the repository lifetime (`:307-315`).
- `loadGraphUncached` `:180-181`: `if (await isShallowRepository(ctx)) return undefined;`
  — ADR-544's gate, on **file presence**, memoised per `Context`. `readCommitMeta`
  inherits it for free.
- Its two existing callers are `walk-commits.ts:80` and `commit-date-walk.ts:176`; this
  part adds a third path, it does not change those.

`src/application/primitives/internal/shallow-set.ts`:
`loadShallowSet(ctx): Promise<ReadonlySet<ObjectId>>` `:77-78` — one memoised promise
per session (`:31`, `:61-74`). `applyGraft(commit, shallow)` (`domain/commit/graft.ts:40-44`)
returns the same object when nothing is grafted.

**New file** — `src/application/primitives/internal/read-commit-meta.ts` (**internal**;
`primitives/index.ts` is NOT touched; commands import it by path, as `name-rev.ts:24-25`
already imports from `primitives/internal/`):

```ts
export const GENERATION_INFINITY = Number.POSITIVE_INFINITY;

export interface CommitMeta {
  readonly parents: ReadonlyArray<ObjectId>;
  readonly committerDate: number;
  /** Graph generation — topo level or corrected commit date — or
   *  GENERATION_INFINITY when no graph serves this commit (or serves it with 0). */
  readonly generation: number;
}

const fromHeader = (header: CommitHeader): CommitMeta => ({
  parents: header.parents,
  committerDate: header.committerDate,
  generation: header.generation > 0 ? header.generation : GENERATION_INFINITY,
});

/** Graph first; `readObject` + `applyGraft` fallback. `undefined` for a non-commit
 *  object; OBJECT_NOT_FOUND propagates. A graph hit for a missing body does not
 *  throw — git's `repo_parse_commit` succeeds from the graph too. */
export const readCommitMeta = async (ctx: Context, id: ObjectId): Promise<CommitMeta | undefined> => {
  const header = await commitHeader(ctx, id);
  if (header !== undefined) return fromHeader(header);
  const object = await readObject(ctx, id);
  if (object.type !== 'commit') return undefined;
  const grafted = applyGraft(object, await loadShallowSet(ctx));
  return {
    parents: grafted.data.parents,
    committerDate: grafted.data.committer.timestamp,
    generation: GENERATION_INFINITY,
  };
};

/** For a `Commit` already in hand (a peeled ref tip): the graph supplies only
 *  the generation, with no object read. */
export const commitMetaOf = async (ctx: Context, commit: Commit): Promise<CommitMeta> => {
  const header = await commitHeader(ctx, commit.id);
  const grafted = applyGraft(commit, await loadShallowSet(ctx));
  return {
    parents: grafted.data.parents,
    committerDate: commit.data.committer.timestamp,
    generation: header === undefined ? GENERATION_INFINITY : fromHeader(header).generation,
  };
};
```

**Graft consistency:** the graph is disabled whenever `.git/shallow` exists, so a graph
hit never needs grafting and the fallback always grafts. `loadShallowSet` is one
memoised promise per session, which is why the design's "hoist `loadShallowSet` out of
`merge-base`'s per-commit closure and `name-rev`'s `expandParents`" items are discharged
**by construction** — those call sites disappear in Parts 7 and 8.

**Consumer migrated here** — `src/application/primitives/bisect-midpoint.ts` (173 lines)
- `type CommitEntry = { readonly date: number; readonly parents: ReadonlyArray<ObjectId> }` `:12-15`.
- `readCommitEntry` `:17-22`:
  `readObject` → `if (obj.type !== 'commit') throw invalidWalkInput(\`bisectMidpoint: ${id} is not a commit\`)`
  → `applyGraft(obj, await loadShallowSet(ctx))` → `{ date, parents }`. Replace the body
  with `readCommitMeta`; `undefined` maps to the **same refusal with the message
  verbatim**. A missing object still surfaces `OBJECT_NOT_FOUND` from the fallback's
  `readObject`. Drop the now-unused `applyGraft`/`loadShallowSet`/`readObject` imports if
  nothing else uses them.
- `paintReachable` `:28-47`, `makeEntryReader` `:56-65`, `walkCandidatesNewestFirst`,
  `projectOldestFirst`, `collectCandidatesOldestFirst`, `deriveMidpoint`,
  `bisectMidpoint` — **unchanged**.
- `Stryker disable` comments at `:37`, `:42`, `:81`, `:94`: all sit in structures this
  part does not change (`paintReachable`'s two guards, `less`'s `ins` tie-break, the
  `ins++` counter). Re-run them after the change and confirm each still holds; do not
  edit the prose.

**The read-counter trap (PC-3).** The commit-graph file lives at
`objects/info/commit-graph`, so a filter of `path.includes('objects/')` counts the graph
probe as an object read — and after this part every consumer probes the graph once per
`Context` even when none exists. Narrow the counter to real object-store reads:
`objects/pack/` or `objects/<2 hex>/`, excluding `objects/info/`. Apply the narrowing to
`withCountedObjectReads` (`test/unit/application/commands/name-rev.test.ts:544-556`) if
this part touches it, and use the narrowed filter for every new assertion.

**Tests**
- **New** `test/unit/application/primitives/internal/read-commit-meta.test.ts`:
  graph hit (parents/date/generation from `writeCommitGraph`); graph value `0` mapping to
  `GENERATION_INFINITY`; graph miss falling back to the object read **plus graft** (seed
  `.git/shallow` with `await ctx.fs.writeUtf8(\`${ctx.layout.gitDir}/shallow\`, \`${boundary}\n\`)`,
  the pattern at `walk-commits.test.ts:974` — note that seeding it also disables the
  graph, which is exactly the shape to test); a non-commit object → `undefined`; a
  missing object → `OBJECT_NOT_FOUND` asserted on `.data.code`; `commitMetaOf` reads
  **zero** objects. Each branch isolated — the guard rule applies.
- `test/unit/application/primitives/bisect-midpoint.test.ts` (345 lines): results
  identical with and without a graph; **zero** object-store reads after
  `writeCommitGraph`; the `is not a commit` refusal asserted on `.data` (code + the exact
  message).
- `writeCommitGraph(ctx, layers)` is `test/unit/application/primitives/fixtures.ts:414`,
  `(ctx, ReadonlyArray<ReadonlyArray<Commit>>)`: the outer array is the chain layers,
  base → tip; a one-element outer array writes a plain `objects/info/commit-graph`.
  Canonical single-layer call: `await writeCommitGraph(base, [await asCommits(base, ids)]);`
  (`walk-commits.test.ts:1169`). **Do not confuse it with the production primitive of the
  same name** in `src/application/primitives/write-commit-graph.ts`, which takes only
  `(ctx)`.
- `instrumentedContext(base)` → `{ ctx, calls }`, `calls()` = `{ method, path }[]`
  (`fixtures.ts:246`).
- **Interop**: extend `test/integration/bisect-midpoint-interop.test.ts` (355 lines,
  `SETUP_TIMEOUT = 60_000`, per-describe `beforeAll`, `makeRepo` at `:35-42`). Re-run the
  existing `git rev-list --bisect` / `--bisect-vars` expectations after
  `git commit-graph write --reachable`, with a **fresh** tsgit `Context` built after the
  git write. Add one arm where the graph is written by
  `repo.maintenance({ tasks: ['commit-graph'] })` instead of by git.

**Implementation-time fs oracle** (recorded, not asserted): the `fs-count.cjs` shim from
Part 2 over `~/.cache/tsgit-bench/medium-commit-graph-v3` (head
`87723053c29f07c840c0d69d2c60ac7d7f0b4407`, a real `objects/info/commit-graph` is
present), calling
`bisectMidpoint(ctx, [<an older commit on the fixture's history>], <head>)` — pick the
`good` seed by walking back a few hundred commits from `meta.headCommitId`: **zero**
`readFile`/`open` of `objects/pack/` or `objects/<xx>/` after the graph load. Report the
counts.

### TDD steps

1. **RED — a graph hit serves parents, date and generation with no object read.**
   New `read-commit-meta.test.ts`: build a chain, `writeCommitGraph(ctx, [commits])`,
   wrap with `instrumentedContext`, call `readCommitMeta`; assert the returned
   `parents`/`committerDate` and that the narrowed object-store read filter yields `[]`.
   Expected failure: the module does not exist.
2. **RED — a stored generation of `0` maps to `GENERATION_INFINITY`.** Assert
   `result.generation === Number.POSITIVE_INFINITY` for that case, and a finite value for
   a normal graph entry. Both arms, separately.
3. **RED — a graph miss falls back to the object read and grafts.** Seed `.git/shallow`
   so the graph is off, and assert the returned `parents` are the grafted (empty) list
   for the boundary commit and `generation === GENERATION_INFINITY`.
4. **RED — a non-commit returns `undefined`; a missing object propagates.** Two separate
   rows; the second asserts `.data.code === 'OBJECT_NOT_FOUND'`.
5. **RED — `commitMetaOf` reads no object.** Pass a `Commit` already in hand; assert the
   narrowed read filter yields `[]` both with and without a graph.
6. **GREEN** — write `read-commit-meta.ts`.
7. **RED — bisect reads no commit objects once a graph is present.**
   `bisect-midpoint.test.ts`: an existing history fixture plus `writeCommitGraph`; assert
   the narrowed object-store read filter is `[]` and the `BisectMidpoint` result is
   byte-identical to the no-graph run.
8. **GREEN** — rewrite `readCommitEntry` over `readCommitMeta`; keep the
   `bisectMidpoint: <id> is not a commit` message verbatim and assert it on `.data`.
9. **RED → GREEN — interop.** Extend `bisect-midpoint-interop.test.ts` with the two graph
   arms described above.
10. **REFACTOR** — `fromHeader` is the single place the `> 0` mapping lives; no consumer
    repeats it.
11. **VERIFY the suppressions** at `bisect-midpoint.ts:37,42,81,94` still hold; run the
    part gate and record that they were re-read, not edited.
12. **Surface gate** — `npm run docs:json`; expect an empty `reports/api.json` diff
    (nothing public changed); commit it if not.

### Gate

```
npx vitest run test/unit/application/primitives/internal/read-commit-meta.test.ts test/unit/application/primitives/bisect-midpoint.test.ts test/unit/application/primitives/internal/read-commit-graph.test.ts 2>&1 | tee /tmp/p6-vitest.log; echo $?
npx vitest run test/integration/bisect-midpoint-interop.test.ts 2>&1 | tee /tmp/p6-interop.log; echo $?
npm run check:types 2>&1 | tee /tmp/p6-types.log; echo $?
npx tsc --noEmit -p tsconfig.json 2>&1 | tee /tmp/p6-tsc.log; echo $?
npm run check:architecture 2>&1 | tee /tmp/p6-arch.log; echo $?
./node_modules/.bin/biome check src/application/primitives/internal/read-commit-meta.ts src/application/primitives/bisect-midpoint.ts test/unit/application/primitives/internal/read-commit-meta.test.ts test/unit/application/primitives/bisect-midpoint.test.ts test/integration/bisect-midpoint-interop.test.ts 2>&1 | tee /tmp/p6-biome.log; echo $?
npm run check:spelling 2>&1 | tee /tmp/p6-spell.log; echo $?
npm run docs:json 2>&1 | tee /tmp/p6-docs-json.log; echo $?; git diff --stat -- reports/api.json
```

### Commit

```
perf(bisect): serve commit parents and dates from the commit-graph
```

## Part 7 — merge-base: graph metadata, git's generation cutoff, and the newest base

### Context

Depends on Part 6. Three changes to one file, one commit: migrate to `readCommitMeta`,
add git's `min_generation` break, and replace the single-base selection rule
(ADR-845 supersedes ADR-191). The last is a **result-bearing behaviour change** — it is
ratified, and it is pinned by interop, never assumed.

**Mechanism (git) — Pin G1**, `commit-reach.c:100-191` `paint_down_to_common(r, one, n, twos, min_generation, mb_flags, result)`:
the queue compares `compare_commits_by_gen_then_commit_date` unless
`!min_generation && !corrected_commit_dates_enabled(r)` (then date only, `:114-115`);
after each pop `generation = commit_graph_generation(commit); if (min_generation && generation > last_gen) BUG(…); last_gen = generation; if (generation < min_generation) break;` (`:135-142`).
Callers: `merge_bases_many` passes **0** (`:226`); `remove_redundant_no_gen` passes the
**minimum generation over the candidate array** (`:291-308`);
`remove_redundant` (`:458-480`) dispatches to `_with_gen` when generation numbers are
enabled and any candidate is graph-covered — `_with_gen` is a **different algorithm**
(first-parent-style STALE push-up, `:339-456`) and is deliberately **not** replicated:
`_no_gen` + `min_generation` yields the identical reduced set with git's own cutoff and
a small diff. `commit.c` `compare_commits_by_gen_then_commit_date`: higher generation
first, then newer date, else 0.

Soundness of the break with `INFINITY`: a graph contains the full ancestry of every
commit it covers, so no graph-covered commit can be a descendant of a graph-absent one;
`INFINITY` as the minimum therefore stops the walk as soon as a graph-covered commit
pops, which is exactly git's behaviour. tsgit takes the minimum over the **whole**
candidate set where git takes it over the not-yet-redundant entries — never higher than
git's, so it never prunes more than git does.

**File and exact anchors** — `src/application/primitives/merge-base.ts` (164 lines)
- Flags `:11-15` (`PARENT1 1`, `PARENT2 2`, `STALE 4`, `RESULT 8`, `BOTH`) — unchanged.
- `type ReadCommit = (id: ObjectId) => Promise<Commit | undefined>` `:22` becomes
  `(id) => Promise<CommitMeta | undefined>`.
- `makeReadCommit` `:24-38` — memo of `CommitMeta | undefined` over `readCommitMeta`;
  the `readObject` + `loadShallowSet` pair inside it disappears (that is the
  "hoist `loadShallowSet`" item, discharged). **The `Stryker disable next-line all: equivalent`
  at `:27-30`** is a memo-purity argument; its shape is unchanged (a pure memoisation
  over a deterministic read), so **re-prove it in place** — restate the prose against
  `readCommitMeta` rather than copying "the identical commit" wording — or drop it if
  the memo goes.
- `dateOf(commit)` `:40` (`commit?.data.committer.timestamp ?? 0`) becomes
  `meta?.committerDate ?? 0`; add
  `const generationOf = (meta: CommitMeta | undefined): number => meta?.generation ?? GENERATION_INFINITY;`
  — a non-commit id (today's `dateOf(undefined) === 0` leaf) sorts **first** with an
  infinite generation and has no parents, so it can never trip the break the way a `0`
  would.
- `hasNonStale` `:42-49` and its suppression at `:46-49` — **unchanged line, re-run
  under the new comparator**. Its linear scan stays (git's `nonstale_queue` bookkeeping
  is a constant-factor variant, deliberately not adopted).
- `paint` `:57-90` — gains a `minGeneration: number` parameter. The heap entry becomes a
  local type carrying the extra field:
  `interface PaintEntry extends QueueEntry<undefined> { readonly generation: number }`.
  `precedes` (`domain/commit/priority-queue.ts:21-22`) is typed on a **structural**
  `Ordered = { date, oid }` (`:10-13`), so it accepts `PaintEntry` unchanged — no domain
  edit is needed. The comparator becomes generation-then-date **always** (ADR-840):
  `precedesByGeneration(a, b) = a.generation !== b.generation ? a.generation > b.generation : precedes(a, b)`.
  After `heap.pop()` insert
  `if (generation < minGeneration) break;` — `commit-reach.c:141-142`.
  `mark` at `:64-67` pushes `{ oid, date: dateOf(meta), generation: generationOf(meta), value: undefined }`.
  The parent loop at `:81-87` reads `meta?.parents ?? []`.
- The suppressions at `:75-78` (STALE propagation) and `:82-85` (re-mark skip) are
  **unchanged lines inside a changed loop** — re-run them. **The new `break` must be
  killable by a test, never suppressed.**
- `removeRedundant` `:104-120` computes
  `minGenerationOf([candidate, ...others])` and passes it to `paint`
  (`commit-reach.c:291-304`). Its fast-path suppression at `:109-112` is unchanged in
  shape — re-run it now that the function also computes a minimum.
- `mergeBasesMany` `:122-130` passes `0` (`commit-reach.c:226`).
- `mergeBase` `:152-164`: today `const sorted = [...bases].sort(); return options?.all === true ? sorted : sorted.slice(0, 1);`
  (`:162-163`). Under **PC-2** the `{all:true}` path keeps the oid sort verbatim; the
  single-result path becomes "the reduced base with the newest committer date, ties
  resolved as git resolves them". The doc comment at `:145-151` ("Returns the
  lexicographically smallest single base by default") **must be rewritten**.

**Gating is the data, not a flag.** With no graph every `generation` is
`GENERATION_INFINITY`: the comparator degenerates to today's `precedes`, `minGeneration`
is `INFINITY`, and `INFINITY < INFINITY` is false — today's behaviour exactly. That is
why no graph-presence flag is threaded anywhere.

**Pin P5 — the criss-cross (A; B on `b1`; C on `main`; `d1` = C with `b1` merged in;
`e1` = B with `main` merged in).** Bases of `d1`/`e1` are `B = d5169463…`
(committer date 1700000100) and `C = f1123af6…` (1700000200):

| Command | Without graph | With graph |
|---|---|---|
| `merge-base d1 e1` | `f1123af60b53751ca2e82884e3ff12435c1d8b0a` (**C, the newest**) | identical |
| `merge-base --all d1 e1` | `f1123af6…` then `d5169463…` (date-sorted, newest first) | identical |

Lexicographic order puts `d5169463…` (B) first — today's rule returns **B** where git
returns **C**.

**Pin P2 — with and without a graph** (history: `main` m0–m4 with a `--no-ff` merge of
`side`; `side` s0–s3 forked from m1; `topic` = t0 on `side~2`; annotated `v1.0` on
`main~2`, lightweight `light` on `side`). Every row is **identical** before and after
`git commit-graph write --reachable`:
`merge-base main topic` = `bde7cc71322aecd2a621be06fcd7e51d57f83840`;
`merge-base --all main topic` = the same single oid; `merge-base --octopus main topic side`
= the same; `merge-base --is-ancestor side main` exit 0 and `main side` exit 1.

**The tie rule is MEASURED, never assumed (ADR-845).** Before implementing the
selection, probe real git in a `mktemp -d` throwaway (`GIT_*` scrubbed, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, `commit.gpgsign=false`, `tag.gpgsign=false`,
`gc.writeCommitGraph=false`, deterministic `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`):
build a criss-cross whose **two bases share a committer second**, and record the exact
output of `git merge-base d1 e1` and `git merge-base --all d1 e1`, once with no graph and
once after `git commit-graph write --reachable`. Then implement so tsgit reproduces that
order:
- start from a **stable** sort of the reduced bases by committer date descending over
  tsgit's own candidate order (`removeRedundant`'s `kept`, which follows `collectResults`'
  flags-map insertion order, i.e. RESULT-discovery order);
- if the measured tie disagrees, try the reverse pre-sort order (git's `result` list is
  built by prepending, and `commit_list_sort_by_date` is a stable merge sort over it);
- if neither reproduces git's tie deterministically, **stop and escalate**
  `{ part, reason, ≤3 options }` — do not ship an assumed rule.
Whatever is measured becomes an interop row asserted **with and without** a graph.

**Tests**
- `test/unit/application/primitives/merge-base.test.ts` (544 lines).
  - `paint` pops in generation order with a graph: a fixture whose date order and
    generation order **differ** (skew the committer dates so an older-generation commit
    carries a newer date). Kill shape for the comparator mutants.
  - `removeRedundant` breaks at the minimum generation: assert the read count stops
    growing (narrowed object-store filter, PC-3) — kill shape for the break-condition
    mutants.
  - `mergeBasesMany` passes `0`: no break fires even when every generation is finite.
  - No graph → identical results **and** identical read counts to today.
  - The single-result rule: the P5 criss-cross in memory, `mergeBase(ctx, [d1, e1])`
    returns C; `mergeBase(ctx, [d1, e1], { all: true })` returns both, **oid-sorted**
    (PC-2), and the two orders deliberately disagree — assert that explicitly so nobody
    "fixes" it later by accident.
  - **Zero** object-store reads after `writeCommitGraph`.
- **New interop** `test/integration/merge-base-interop.test.ts`. Shape per
  `bisect-midpoint-interop.test.ts` (`describe.skipIf(!GIT_AVAILABLE)`,
  `SETUP_TIMEOUT = 60_000`, `makeRepo` at `:35-42`, `afterAll` removing dirs). Two
  fixtures built in `beforeAll` with real `git`: the P2 history and the P5 criss-cross
  (including the same-committer-second pair). Each row runs **twice** — no graph, then
  after `git commit-graph write --reachable` — with a **fresh** tsgit `Context` after
  each git write, plus one arm where the graph comes from
  `repo.maintenance({ tasks: ['commit-graph'] })`. Rows: `--all` **set** equality
  (PC-2 — set, not order), `--octopus`, the single result where unique, the P5 single
  result (newest), and the measured same-second tie. `--is-ancestor` has no tsgit
  surface here (out of scope, design's own note).

### TDD steps

1. **PROBE (no code yet)** — the same-second criss-cross against real git in a
   `mktemp -d` throwaway, with and without a graph, as described above. Record the two
   orderings verbatim; they go in the part's final message and become the interop row's
   expected values.
2. **RED — the single base is the newest.** `merge-base.test.ts`: the P5 criss-cross in
   memory; `sut = mergeBase`; assert the single result is C. Expected failure: B (the
   lexicographically smallest).
3. **RED — `{all:true}` keeps its oid order.** Same fixture; assert the array is
   oid-sorted and that `result[0]` is **not** the single-result base. This locks PC-2 so
   a later change cannot silently couple the two rules.
4. **RED — the same-second tie matches git.** Assert the measured order from step 1.
5. **RED — the heap pops in generation order.** Skewed-date fixture with a graph; assert
   the pop order (spy the read sequence, or assert the resulting read count under a
   deliberate `minGeneration`). Kill shape for `a.generation > b.generation` mutants.
6. **RED — the reduction breaks at the minimum generation.** Assert the object-store read
   count with a graph is strictly below the no-graph count on the same fixture, and that
   the reduced set is identical. Kill shape for the `<` / `<=` / dropped-`break` mutants.
7. **RED — the main paint does not break.** Assert `mergeBasesMany`'s paint visits the
   same commits with and without finite generations (it passes `0`).
8. **RED — zero object-store reads with a graph.** Narrowed filter (PC-3), asserted
   `toEqual([])`.
9. **GREEN** — migrate `makeReadCommit` to `readCommitMeta`; add `generationOf`,
   `precedesByGeneration`, the `minGeneration` parameter and the `break`; add
   `minGenerationOf` in `removeRedundant`; rewrite the single-result selection; rewrite
   the `:145-151` doc comment.
10. **RED → GREEN — interop.** New `merge-base-interop.test.ts` per the context block.
11. **VERIFY the suppressions**: re-prove `:27-30` in place (restated prose, not copied);
    re-run `:46-49`, `:75-78`, `:82-85`, `:109-112`. The new `break` carries **no**
    suppression.
12. **REFACTOR** — `paint` stays under 20 lines (extract `mark` and the pop guard if
    needed); no comment restates the code.
13. **Surface gate** — `npm run docs:json`; the `mergeBase` doc-comment change moves
    `reports/api.json`; commit it.

### Gate

```
npx vitest run test/unit/application/primitives/merge-base.test.ts 2>&1 | tee /tmp/p7-vitest.log; echo $?
npx vitest run test/integration/merge-base-interop.test.ts 2>&1 | tee /tmp/p7-interop.log; echo $?
npm run check:types 2>&1 | tee /tmp/p7-types.log; echo $?
npx tsc --noEmit -p tsconfig.json 2>&1 | tee /tmp/p7-tsc.log; echo $?
./node_modules/.bin/biome check src/application/primitives/merge-base.ts test/unit/application/primitives/merge-base.test.ts test/integration/merge-base-interop.test.ts 2>&1 | tee /tmp/p7-biome.log; echo $?
npm run check:spelling 2>&1 | tee /tmp/p7-spell.log; echo $?
npm run docs:json 2>&1 | tee /tmp/p7-docs-json.log; echo $?; git diff --stat -- reports/api.json
```

### Commit

```
fix(merge-base)!: return the newest base and stop the paint at git's generation cutoff
```

## Part 8 — name-rev: graph metadata, git's generation cutoff, bounded parent reads

### Context

Depends on Part 6. All three name-rev items land together so the command file is
rewritten once: migrate to `readCommitMeta`/`commitMetaOf`, replace the date cutoff with
git's generation rule when the target has a generation, and overlap the parent reads.

**Mechanism (git) — Pin G2**, `builtin/name-rev.c`:
`:41-42` `static timestamp_t generation_cutoff = GENERATION_NUMBER_INFINITY; static timestamp_t cutoff = TIME_MAX;`
`:53-65` `set_commit_cutoff`: `cutoff = min(cutoff, commit->date); if (generation_cutoff) generation_cutoff = min(generation_cutoff, commit_graph_generation(commit));`
`:70-79` `adjust_cutoff_timestamp_for_slop` (`CUTOFF_DATE_SLOP 86400`, underflow guard).
`:84-91` `commit_is_before_cutoff`:
`if (generation_cutoff < GENERATION_NUMBER_INFINITY) return generation_cutoff && commit_graph_generation(commit) < generation_cutoff; return commit->date < cutoff;`
— the generation test **replaces** the date test when the target has a generation
(ADR-841; the brief's "alongside" is not git's mechanism). The `generation_cutoff &&`
guard is `--all`'s disable path, which tsgit has no surface for. tsgit names one target,
so the minimum over the input commits is that target's own values.

**Visited set vs result.** The cutoff changes which commits are visited, never which
name is returned: a commit with generation below the target's cannot be the target's
descendant (generation decreases strictly along parent edges), so no path from any ref
to the target runs through it, and names flow only along such paths.

**Files and exact anchors**

`src/domain/name-rev/cutoff.ts` (18 lines, whole file rewritten):

```ts
export interface NameRevCutoff { readonly date: number; readonly generation: number }

export const nameRevCutoff = (target: { committerDate: number; generation: number }): NameRevCutoff =>
  ({ date: adjustForSlop(target.committerDate), generation: target.generation });

export const commitIsBeforeCutoff = (
  commit: { committerDate: number; generation: number },
  cutoff: NameRevCutoff,
): boolean =>
  cutoff.generation < GENERATION_INFINITY
    ? commit.generation < cutoff.generation
    : commit.committerDate < cutoff.date;
```

  Today's slop rule moves **verbatim** into `adjustForSlop` (today's `nameRevCutoff`
  body, `:14-17`): `if (targetDate === 0) return 0;` then
  `targetDate > FLOOR + CUTOFF_DATE_SLOP ? targetDate - CUTOFF_DATE_SLOP : FLOOR`, with
  `CUTOFF_DATE_SLOP = 86_400` and `FLOOR = Number.MIN_SAFE_INTEGER`.
  **The `Stryker disable next-line EqualityOperator` at `:16`** (the `>` vs `>=` slop
  boundary) moves with the expression — **re-prove it at its new position** and restate
  the prose there; it is only equivalent because both branches yield `FLOOR` at
  `targetDate === FLOOR + CUTOFF_DATE_SLOP`.
  `GENERATION_INFINITY` must not be imported from `primitives/internal/` into the domain
  (the dependency rule forbids it) — declare the domain's own
  `const GENERATION_INFINITY = Number.POSITIVE_INFINITY;` here, or take it as a plain
  number and compare against `Number.POSITIVE_INFINITY`. Run `npm run check:architecture`.
- `src/domain/name-rev/index.ts:5` already exports both names; add `NameRevCutoff` as a
  type export. The barrel's own doc says these stay **out of** the public `api.json`.

`src/application/commands/name-rev.ts` (141 lines)
- `:55-56` `const targetCommit = (await readObject(ctx, target)) as Commit; const cutoff = nameRevCutoff(targetCommit.data.committer.timestamp);`
  becomes `readCommitMeta(ctx, target)` → `nameRevCutoff(meta)`. `resolveCommit` at `:54`
  already guarantees the target is a commit, so **mirror today's unchecked cast**
  (`const targetMeta = (await readCommitMeta(ctx, target)) as CommitMeta;`) rather than
  adding an `undefined` guard: a guard here is an unreachable branch and the 100 %
  branch-coverage gate cannot be satisfied for it. Do **not** introduce a new error code.
- `:58-60` refs enumeration and the serial `walkRef` loop — **unchanged** (LIFO order and
  `isBetterName` tie-breaks are git's own).
- `walkRef` `:68-84`: the stack holds `Commit`s today (`:76`, `:78`, `:82`); it becomes a
  stack of `interface NameRevNode extends CommitMeta { readonly id: ObjectId }` — i.e.
  `{ id, parents, committerDate, generation }`. `revNames.get(commit.id)` becomes
  `revNames.get(node.id)`, and `seedRef` returns `NameRevNode | undefined` where it
  returns `Commit | undefined` today. The reverse-push at `:81-82` (first parent popped
  first) is git's LIFO traversal — **unchanged**.
- `seedRef` `:87-109`: `:97` `commitIsBeforeCutoff(tip.commit.data.committer.timestamp, cutoff)`
  becomes the object form; `:98` `applyGraft(tip.commit, await loadShallowSet(ctx))`
  becomes `commitMetaOf(ctx, tip.commit)`. The `RevName` seed at `:99-107` is unchanged.
- `expandParents` `:112-133`: `:119` `const shallow = await loadShallowSet(ctx);`
  **disappears** (the hoist item, discharged). The `accept` decision at `:125` is
  synchronous and never depends on a read, so prefetching **after** acceptance changes no
  name. New shape:

```ts
// once per nameRev call
const metas = boundedReaderFor(ctx, 'ioBound', (id) => readCommitMeta(ctx, id));

// inside expandParents
const accepted = parents.filter((oid, index) =>
  accept(revNames, oid, index === 0 ? firstParentName(name) : mergeParentName(name, index + 1)));
for (const oid of accepted) metas.start(oid);          // overlap
for (const oid of accepted) {
  const meta = await metas.start(oid);
  metas.forget(oid);                                    // or the flood is retained
  if (meta === undefined || commitIsBeforeCutoff(meta, cutoff)) continue;
  queued.push({ id: oid, ...meta });
}
```

  `boundedReaderFor(ctx, bucket, read)` is `internal/concurrency.ts:71-75`;
  `BoundedReader<T>` = `{ start(id): Promise<T>; forget(id): void }`
  (`internal/bounded-reader.ts:4-11`), per-id deduped, `bound` concurrent. A non-commit
  parent still `continue`s after having been named — today's behaviour, unobservable,
  because the target is never pruned.
- Drop `applyGraft`, `loadShallowSet` and `readObject` imports if nothing else uses them.

**Gating is the data.** No graph ⇒ the target's generation is `GENERATION_INFINITY` ⇒
the date branch ⇒ today's behaviour byte for byte. A commit outside the graph while the
target is inside carries `GENERATION_INFINITY`, which is never below the cutoff, so it is
traversed — as git does.

**The read-counter trap (PC-3).** `withCountedObjectReads`
(`test/unit/application/commands/name-rev.test.ts:544-556`) counts
`path.includes('objects/')` — which after this part also catches the memoised
`objects/info/commit-graph` probe. **Narrow it** to `objects/pack/` or
`objects/<2 hex>/` and re-verify the existing one-read pins (e.g. `expect(reads()).toBe(1)`
at `:589-601`) under the narrowed filter. If any pin genuinely moves for a real reason,
say which and why in the final message.

**Pin P2 — with and without a graph** (same history as Part 7). Every row **identical**
before and after `git commit-graph write --reachable`:
`name-rev --name-only side~1` = `tags/light~1`; `--tags side~1` = `light~1`;
`--refs='refs/heads/*' side~1` = `side~1`; `--name-only main~3` = `tags/v1.0~1`;
`--name-only <root>` = `tags/v1.0~3`; `describe --contains side~1` = `light~1`.

**Tests**
- `test/unit/domain/name-rev/cutoff.test.ts` **already exists** (62 lines): an
  `it.each` truth table for `commitIsBeforeCutoff(commitDate, cutoff)` (3 rows) and one
  for `nameRevCutoff(targetDate)` (4 rows, including `targetDate === 0`,
  `Number.MIN_SAFE_INTEGER`, and the floor-plus-slop boundary at
  `MIN_SAFE_INTEGER + 86_400 + 1`). **Migrate both tables to the object signatures and
  extend**, never rewrite from scratch: the four `nameRevCutoff` rows keep their exact
  expected values (the slop rule is unchanged) and the `commitIsBeforeCutoff` table grows
  to `{commit generation finite / ∞} × {cutoff generation finite / ∞} × {date below / at / above}`.
- `test/unit/domain/name-rev/cutoff.properties.test.ts` **already exists** (71 lines,
  4 properties: totality at `numRuns: 200`, monotonicity in date at 200, the
  strictly-between-`cutoff-1`-and-`cutoff` threshold at 200, and the one-day-slop
  identity at 100). All four are written against the **old scalar signatures** and will
  not compile after the change. **Migrate each to the object form** — the date branch is
  reached by giving both the commit and the cutoff an infinite generation, so every
  existing property survives verbatim in meaning — and add one generation-branch
  property (with a finite cutoff generation the verdict depends only on the commit's
  generation, never on its date). Keep the tiered `numRuns` values. Never commit a seed.
- `test/unit/domain/name-rev/arbitraries.ts` needs **no change**: its `generation` field
  (`:12`) belongs to `RevName` — the name-quality generation used by `isBetterName` — and
  is a different concept from the commit-graph generation this part introduces. Do not
  conflate them, in code or in test names.
- `test/unit/application/commands/name-rev.test.ts`: with a graph, a parent whose
  generation is below the target's is **not** expanded (narrowed read count) while a
  graph-absent parent **is**; the existing read-count pins hold under the narrowed
  filter; the parent reads **overlap** — spy the bounded reader and assert `start` was
  called for **every** accepted parent before the first `await` resolves; `forget` is
  called after consumption (assert the memo does not grow across a long flood); LIFO
  order and the `~`/`^` steps are unchanged on the merge fixtures.
- **Interop**: extend `test/integration/name-rev-interop.test.ts` (329 lines; five nested
  describes, each with its own `beforeAll(..., SETUP_TIMEOUT)`; `renderNameRev` /
  `gitNameRev` helpers already in the file). Re-run every existing expectation after
  `git commit-graph write --reachable` with a **fresh** `Context`, and add one arm using
  `repo.maintenance({ tasks: ['commit-graph'] })`.

**Bench read-out.** Re-run `npx vitest bench --run --config vitest.bench.config.ts test/bench/name-rev.bench.ts` and report the
many-tag arm's median against Part 1's recorded "before" (PC-1). The tiered rows have a
~0.5 ms per-command floor that hides this change; the many-tag arm is the one that can
show it. Report the existing tiered rows too, as a non-regression check.

### TDD steps

1. **RED — the cutoff truth table.** Migrate and extend the **existing**
   `test/unit/domain/name-rev/cutoff.test.ts` to the object signatures (the four
   `nameRevCutoff` rows keep their exact expected values) and grow the
   `commitIsBeforeCutoff` table to the generation × generation × date matrix. Migrate the
   four properties in `cutoff.properties.test.ts` in the same step and add the
   generation-branch property. Expected failure: the new signatures do not exist (type
   errors in both files).
2. **GREEN** — rewrite `domain/name-rev/cutoff.ts`; move the slop expression verbatim
   into `adjustForSlop` and **re-prove** the `EqualityOperator` suppression at its new
   position (restated prose, same argument); export `NameRevCutoff` from the barrel.
3. **RED — with a graph, a below-cutoff parent is not expanded.**
   `name-rev.test.ts`: a fixture where a ref's ancestry contains a commit whose
   generation is below the target's; assert (narrowed read count) that it is not read,
   and that the returned name is unchanged from the no-graph run.
4. **RED — a graph-absent parent is still traversed.** Same fixture with a partial graph
   covering only some commits; assert the graph-absent commit **is** expanded.
5. **RED — parent reads overlap.** Spy the bounded reader (inject it, or assert the
   observable: with a bound of N, N reads are in flight before the first resolves);
   assert `start` for every accepted parent precedes the first consumption, and that
   `forget` runs per consumption so the memo does not grow with the flood.
6. **RED — narrow the read counter, then re-assert the existing pins.** Change
   `withCountedObjectReads` to exclude `objects/info/`; run the existing read-count tests
   and record any that legitimately move.
7. **GREEN** — migrate `name-rev.ts`: target via `readCommitMeta`, `seedRef` via
   `commitMetaOf`, meta-node stack in `walkRef`, `expandParents` two-phase with the
   bounded reader and the new cutoff call, imports cleaned up.
8. **RED → GREEN — interop.** Extend `name-rev-interop.test.ts` with the graph re-run and
   the `maintenance` arm.
9. **REFACTOR** — `expandParents` stays under 20 lines; the accept-then-prefetch split
   reads as two named steps.
10. **VERIFY** — `npm run check:architecture` (the domain must not import
    `primitives/internal/`).
11. **Surface gate** — `npm run docs:json`; commit `reports/api.json` if it moves.
12. **Bench** — the many-tag arm, reported against Part 1's before number.

### Gate

```
npx vitest run test/unit/domain/name-rev test/unit/application/commands/name-rev.test.ts 2>&1 | tee /tmp/p8-vitest.log; echo $?
npx vitest run test/integration/name-rev-interop.test.ts 2>&1 | tee /tmp/p8-interop.log; echo $?
npm run check:types 2>&1 | tee /tmp/p8-types.log; echo $?
npx tsc --noEmit -p tsconfig.json 2>&1 | tee /tmp/p8-tsc.log; echo $?
npm run check:architecture 2>&1 | tee /tmp/p8-arch.log; echo $?
./node_modules/.bin/biome check src/domain/name-rev/cutoff.ts src/domain/name-rev/index.ts src/application/commands/name-rev.ts test/unit/domain/name-rev/cutoff.test.ts test/unit/domain/name-rev/cutoff.properties.test.ts test/unit/application/commands/name-rev.test.ts test/integration/name-rev-interop.test.ts 2>&1 | tee /tmp/p8-biome.log; echo $?
npm run check:spelling 2>&1 | tee /tmp/p8-spell.log; echo $?
npm run docs:json 2>&1 | tee /tmp/p8-docs-json.log; echo $?; git diff --stat -- reports/api.json
```

### Commit

```
perf(name-rev): prune by generation with a graph and overlap the parent reads
```

## Part 9 — `blame -L` seeds the requested window

### Context

Independent — reorderable anywhere after Part 1. Today `blame` seeds the **whole file**
and filters at the end; git seeds one `blame_entry` over `[bottom, top)`. ADR-844 also
makes inverted bounds **swap** instead of refusing — the only intentional behaviour
change in `blame`.

**Mechanism (git) — Pin G6**, `builtin/blame.c` `cmd_blame`:
`lno = sb.num_lines;` … `if ((!lno && (top || bottom)) || lno < bottom) die(Q_("file %s has only %lu line", "file %s has only %lu lines", lno), sb.path, lno); if (bottom < 1) bottom = 1; if (top < 1 || lno < top) top = lno; bottom--;`
then one `blame_entry` per merged range. `line-range.c` `parse_loc`:
`if (num <= 0) die("-L invalid line number: %ld", num);`; `parse_range_arg`:
`if (*begin && *end && *end < *begin) { SWAP(*end, *begin); }`.
**Order of checks: each bound `> 0` (begin first), then the swap, then beyond-EOF, then
the clamp.**

**File and exact anchors** — `src/application/commands/blame.ts` (528 lines)
- `BlameOptions.range` doc `:52-57` — "a start below 1, a start past the last line, or
  an inverted/non-integer range refuse" must lose the *inverted* clause.
- `blame(...)` `:169`: `return { path: filePath, lines: applyRange(lines, opts.range) };`
  — `applyRange` goes; the final sort at `:168` stays.
- `applyRange` `:256-271` — **deleted**, its messages preserved verbatim in the new
  resolver: `line numbers must be integers` (`:264`, tsgit-only, JS numbers),
  `invalid line number: ${n}` (`:266`), `file has only ${n} lines` (`:267`).
  `range end ${end} precedes start ${start}` (`:268`) is **removed** — git never emits
  it, it swaps.
- New pure helpers, in git's check order:

```ts
interface LineWindow { readonly start: number; readonly last: number }  // 1-based inclusive, clamped

const resolveLineWindow = (lineCount: number, range: BlameOptions['range']): LineWindow | undefined => {
  if (range === undefined) return lineCount === 0 ? undefined : { start: 1, last: lineCount };
  const { start, end } = range;
  if (!Number.isInteger(start) || !Number.isInteger(end)) throw invalidOption('-L', 'line numbers must be integers');
  if (start < 1) throw invalidOption('-L', `invalid line number: ${start}`);
  if (end < 1) throw invalidOption('-L', `invalid line number: ${end}`);
  const [bottom, top] = end < start ? [end, start] : [start, end];   // git swaps
  if (bottom > lineCount) throw invalidOption('-L', `file has only ${lineCount} lines`);
  return { start: bottom, last: Math.min(top, lineCount) };
};

const seedEntry = (window: LineWindow): BlameEntry =>
  ({ finalStart: window.start - 1, count: window.last - window.start + 1, sourceStart: window.start - 1 });
```

- **Both seed paths resolve the window BEFORE their empty-file early return**, on the
  queried file's own line count:
  - `seed` `:273-297`: `const lines = splitLines(blob);` at `:284`, early return at
    `:286`, `entries: [{ finalStart: 0, count: lines.length, sourceStart: 0 }]` at `:292`.
    Resolve from `lines.length` **before** `:286`, then seed `[seedEntry(window)]`. So
    `-L 1,1` on an empty file refuses `file has only 0 lines` (P3), while a no-range
    empty file still returns no lines with exit 0.
  - `seedWorkingTree` `:186-225`: `const workingLines = splitLines(workingBlob);` at
    `:194`, early return at `:196`, `whole` at `:197-199`. Resolve from
    `workingLines.length` before `:196` and use `[seedEntry(window)]` in place of `whole`
    for **both** the `splitAgainstParent` split at `:205` and the staged-new
    `finalizeUncommitted` at `:221`.
- `finalLine`/`sourceLine` stay **absolute** — git's porcelain prints absolute numbers
  (P3 `-L 2,4` shows `2 2 1`, `3 3 1`, `4 4 1`).
- **`Stryker disable` comments at `:195` and `:285`** (the two empty-file
  `ConditionalExpression` guards) — **re-prove them in place with restated prose**: with
  the window resolved first, each guard now only short-circuits the **no-range** empty
  case, so the old argument ("the zero-count entry flows through and yields no lines")
  still holds but for a narrower input set. Say so; do not copy the old wording.
- `:314`, `:508`, `:521` suppressions are in untouched structures — re-run them.

**Pin P3 matrix** (file `f`: 5 lines; b0 all lines, b1 rewrites line 2, b2 rewrites line 4):

| Command | Output / refusal | Exit |
|---|---|---|
| `blame -L 2,4 --porcelain f` | three entries, headers `e67d6b21… 2 2 1`, `76d8bfec… 3 3 1` (+`boundary`), `b5519a32… 4 4 1`; absolute line numbers; full author/committer/summary/previous/filename blocks | 0 |
| `blame -L 3,100 -s f` | lines 3, 4, 5 (clamped) | 0 |
| `blame -L 6,7 f`, `blame -L 6,6 f` | `fatal: file f has only 5 lines` | 128 |
| `blame -L 4,2 -s f`, `blame -L 5,3 -s f` | **swapped**: lines 2–4 / 3–5 | 0 |
| `blame -L 0,3 -s f` | `fatal: -L invalid line number: 0` | 128 |
| `blame -L -1,3 -s f` | `fatal: -L invalid line number: -1` | 128 |
| `blame -L 1,0 -s HEAD~2 -- f` | `fatal: -L invalid line number: 0` | 128 |
| `blame -L 3,3`, `-L 5,5` | one line | 0 |
| `blame -L 2,4 -s HEAD~2 -- f` | lines 2–4 all `^76d8bfe` | 0 |
| `blame -L 1,3 --porcelain g` after `git mv f g` | entries carry `filename f` (rename-aware) | 0 |
| `blame -L 1,1 e` (empty file) | `fatal: file e has only 0 lines` | 128 |
| `blame e` (empty, no range) | no output | 0 |
| `blame -L 2,4 --porcelain g`, uncommitted edit on line 3 (worktree mode) | `e67d6b21… 2 2 1`, `0000000000000000000000000000000000000000 3 3 1`, `b5519a32… 4 4 1` | 0 |

**Check-order kill shape:** `-L 0,9` on a 5-line file must say
`invalid line number: 0`, **not** `has only 5 lines`. Both guards of the two-bound check
need their own row (`start < 1` alone, `end < 1` alone).

**Tests**
- `test/unit/application/commands/blame.test.ts` (1306 lines) **already carries the range
  suite** — extend it, do not write a parallel one. Local fixture: `buildThreeLineFile()`.
  - `:920-929` window case and `:931-940` clamp case (`{ start: 2, end: 100 }` → lines
    2, 3) stay green unedited.
  - `:943-973` `describe('When the range is invalid')` holds an `it.each` of four rows
    asserting `data: { code: 'INVALID_OPTION', option: '-L', reason }`. **Delete the
    `'an inverted range'` row (`:945-949`, `{ start: 3, end: 1 }`, reason
    `'range end 1 precedes start 3'`) — that input is now a success** and moves to the
    sibling `describe` as a swap case yielding lines 1–3. Keep `'a start below 1'`,
    `'a start past the last line'` and `'a non-integer bound'` verbatim. **Add** rows for
    `end < 1` (`{ start: 1, end: 0 }` → `invalid line number: 0`), a negative start
    (`{ start: -1, end: 3 }` → `invalid line number: -1`), and the empty file with a
    range (`file has only 0 lines`).
  - Add the rest of the P3 matrix over the committed and worktree seed paths — window,
    clamp, swap, the empty file **without** a range (no lines, no throw), a staged-new
    file with a range.
- **Interop**: extend `test/integration/blame-interop.test.ts` (316 lines,
  `SETUP_TIMEOUT = 60_000`, one shared `beforeAll` at `:163-227` building seven fixtures
  — `linear, prepend, merged, renamed, worktree, deepAncestry, oursMerge` — and an
  `afterAll` at `:229-235`). The porcelain reconstruction helper `renderPorcelain` is
  already there at `:110-133`, with `metadataBlock`/`uncommittedBlock` at `:67-105` and
  `scrubNow` at `:148-152`; the matrix runner is `it.each(BLAME_PORCELAIN_MATRIX)` at
  `:292-314` and already threads `range` into both the tsgit call and the `-L` git args.
  **Add rows to `BLAME_PORCELAIN_MATRIX`**; do not write a new runner. For the refusal
  rows use `tryRunGitWithExit` (`interop-helpers.ts:257`) and compare tsgit's
  `INVALID_OPTION` + message against git's `fatal:` line and exit 128. Add an empty-file
  fixture (`e`) to the `beforeAll`.

### TDD steps

1. **RED — the window is resolved on the queried file's line count, before the empty
   check.** `blame.test.ts`: `-L 1,1` on an empty committed file refuses
   `file has only 0 lines`; `blame` with no range on the same file returns no lines and
   does not throw. Two rows. Expected failure: the first returns an empty result instead
   of refusing.
2. **RED — inverted bounds swap.** `-L 4,2` on the 5-line fixture returns lines 2–4;
   `-L 5,3` returns 3–5. Expected failure: `INVALID_OPTION` `range end 2 precedes start 4`.
3. **RED — check order.** `-L 0,3` says `invalid line number: 0`; `-L 1,0` says
   `invalid line number: 0`; `-L -1,3` says `invalid line number: -1`; `-L 6,7` says
   `file has only 5 lines`. Each guard triggered **alone**; each assertion on `.data`
   (`code`, `option`, `reason`/message).
4. **RED — the seed carries only the window.** With `instrumentedContext` (or a spy on
   the scheduler), assert the committed-rev seed schedules **one** entry of
   `count = last - start + 1`, not the whole file, and that ancestors outside the window
   are not walked (read count).
5. **RED — the worktree path takes the window too.** `-L 2,4` in worktree mode with an
   uncommitted line 3 yields the three-entry shape from P3's last row, with the
   uncommitted line carrying the zero oid.
6. **GREEN** — add `LineWindow`/`resolveLineWindow`/`seedEntry`; wire both seed paths;
   delete `applyRange` and its call at `:169`; update the `BlameOptions.range` doc at
   `:52-57`.
7. **RED → GREEN — interop.** Add the P3 rows to `BLAME_PORCELAIN_MATRIX` plus the
   refusal rows through `tryRunGitWithExit`, and the empty-file fixture.
8. **VERIFY the suppressions** at `:195` and `:285`: restate each proof against the
   narrowed no-range-only input set; re-run `:314`, `:508`, `:521`.
9. **REFACTOR** — `resolveLineWindow` stays a single total function with early returns
   and no nesting beyond one level.
10. **Surface gate** — `npm run docs:json`; the `BlameOptions.range` doc-comment change
    moves `reports/api.json`; commit it.
11. **Bench** — `npx vitest bench --run --config vitest.bench.config.ts test/bench/blame.bench.ts`; report against the
    orchestrator's `bench:ab` rows (this file exists on `main`, so `bench:ab` compares it
    normally).

### Gate

```
npx vitest run test/unit/application/commands/blame.test.ts 2>&1 | tee /tmp/p9-vitest.log; echo $?
npx vitest run test/integration/blame-interop.test.ts 2>&1 | tee /tmp/p9-interop.log; echo $?
npm run check:types 2>&1 | tee /tmp/p9-types.log; echo $?
npx tsc --noEmit -p tsconfig.json 2>&1 | tee /tmp/p9-tsc.log; echo $?
./node_modules/.bin/biome check src/application/commands/blame.ts test/unit/application/commands/blame.test.ts test/integration/blame-interop.test.ts 2>&1 | tee /tmp/p9-biome.log; echo $?
npm run check:spelling 2>&1 | tee /tmp/p9-spell.log; echo $?
npm run docs:json 2>&1 | tee /tmp/p9-docs-json.log; echo $?; git diff --stat -- reports/api.json
```

### Commit

```
fix(blame)!: seed only the requested line window and swap inverted bounds as git does
```

## Part 10 — Stop stalling the date walk and the commit-diff loops

### Context

Independent — reorderable anywhere after Part 1. Three behaviour-preserving changes that
all remove work the walk loop pays for and immediately discards. They are one part
because each alone is a thin commit and all three are "the loop stops waiting or stops
holding".

**(i) Date-walk single-parent fast path** — `src/application/primitives/internal/commit-date-walk.ts`
(192 lines)
- `enqueueParents` `:145-162`: the filter at `:146-150` selects unseen parents, then
  `Promise.allSettled` at `:151-153` fans out even for **one** parent, rejections
  rethrow in array order at `:154-156`, and pushes happen in array order at `:157-161`.
  New shape:

```ts
const parents = selectParents(commit, walk.firstParent).filter(claimUnseen(walk));  // today's :146-150
if (parents.length === 0) return;
if (parents.length === 1) return enqueueCommit(ctx, walk, parents[0]!);
… today's allSettled arm, unchanged, for ≥ 2 parents …
```

  `enqueueCommit` `:164-169` already awaits `resolveHeapEntry` and pushes — the
  single-parent arm reuses it verbatim, so a rejected single-parent read still rethrows.
- The per-pop `frontier` closure at `:117` (`frontier: () => walk.heap.entries().map((entry) => entry.oid)`)
  is hoisted to **one** closure per walk over the same `walk.heap`. Its contract is a live
  snapshot "valid until the iterator resumes" (`:21-22`) — same object, same reads.
  `frontierEmpty` at `:116` stays a per-step boolean.
- `DateWalkStep`'s shape `:18-23` is **unchanged** (ADR-460). Its consumers are
  `describe.ts:281,289,344` and `walk-commits-by-date.ts:61`.
- The `≥ 2`-parent arm's array-order invariant is documented at `:135-144` and pinned by
  `test/unit/application/primitives/internal/commit-date-walk.test.ts:257-295` (diamond
  frontier snapshots `[[], [b], [a], []]`, emptiness `[true, false, false, true]`) —
  those tests must stay green **unedited**.
- `describe.ts:280`'s `Stryker disable next-line ArrowFunction,ConditionalExpression`
  sits on `step.frontier().every(...)` — an untouched consumer of a now-hoisted closure.
  Re-run it; do not edit.
- `walk-commits-by-date.ts:51,53` suppressions are untouched — re-run.

**(j) `whatchanged`** — `src/application/commands/whatchanged.ts` (73 lines)
- `:54-71`: the loop skips merges (`:55`), applies the `before` filter (`:56-58`), awaits
  `diffCommitAgainstParent` **inside** the loop (`:59`), pushes (`:60-68`), counts
  `yielded` and `break`s at `limit` (`:69-70`). Restructure: collect the **selected**
  commits (same merge filter, same `before` filter, same `limit` counted on selected
  commits, same `break`), then
  `boundedMapFor(ctx, 'ioBound', selected, (c) => diffCommitAgainstParent(ctx, c.data.parents[0], c.data.tree))`
  and zip in order. Output order and `limit` semantics are identical; the walk's
  read-ahead is no longer stalled by a diff per iteration.
- `boundedMapFor` from `../primitives/internal/concurrency.js` (`:53-58`), input-order
  preserving.

**(j) `range-diff`** — `src/application/commands/range-diff.ts` (115 lines) and
`src/domain/range-diff/`
- `hydrate` `:66-82` returns a `CommitPatchInput` carrying `files` from
  `materialisePatchFiles` — i.e. every changed file's `oldContent`/`newContent` for
  **every commit of both series**, held until `rangeDiffEntries` renders. Make `hydrate`
  render immediately: call `renderRangePatch(input)` (`domain/range-diff/patch-text.ts:187`)
  → `RenderedPatch` (`{ id, subject, patch, diff, diffsize }`, strings only, `:43`) and
  return that; the `PatchFile` contents then go out of scope per commit inside `hydrate`.
- `hydrateSeries` `:85-89` and `readSeries` `:92-104` change their element type from
  `CommitPatchInput` to `RenderedPatch`.
- `domain/range-diff/range-diff.ts:12-21` `rangeDiffEntries(oldCommits, newCommits, creationFactor)`
  currently maps `renderRangePatch` over both inputs at `:17-18`. Those two `.map`s become
  the **caller's**; the signature becomes
  `rangeDiffEntries(old: ReadonlyArray<RenderedPatch>, new: ReadonlyArray<RenderedPatch>, factor: number)`.
  `correspond` (`correspond.ts:29-30,72-73,103-104`) and `interleave` (`interleave.ts:34`)
  already take `RenderedPatch`.
- `domain/range-diff/index.ts` (3 lines) exports `CommitPatchInput` at `:2`; add
  `RenderedPatch` and `renderRangePatch`. Both are **internal** (0 hits in
  `reports/api.json`); verify with the api.json check.
- Output is unchanged: `RangeDiffCommit` reads only `id`/`subject`
  (`interleave.ts:34-62`). Patch text is already bounded by `MAX_PATCH_TEXT_CHARS`.

**Tests**
- `test/unit/application/primitives/internal/commit-date-walk.test.ts` (652 lines):
  a linear-history case asserting the same yield sequence with **zero** `allSettled`
  calls (spy `Promise.allSettled`), and that a rejecting single parent still rethrows the
  original error. **Boundary kill shape:** `length === 1` vs `<= 1` — assert
  `enqueueCommit` is **not** called when there are zero eligible parents, or the `<= 1`
  mutant survives.
- `test/unit/application/commands/whatchanged.test.ts` (299 lines): order and `limit`
  preserved; `boundedMapFor` called **once** with the selected commits (spy the callee's
  captured argument).
- `test/unit/application/commands/range-diff.test.ts` (378 lines) and
  `test/unit/domain/range-diff/range-diff.test.ts` (65 lines): `rangeDiffEntries` over
  rendered patches equals today's entries; `hydrate` returns no `oldContent`/`newContent`
  (assert **key absence** on the returned object with `Object.keys`, not `toEqual`).
- No interop change is owed by this part; `test/integration/whatchanged-interop.test.ts`
  and `range-diff-interop.test.ts` exist and must stay green unedited — run them.

**Bench oracle.** The reviewer's 1.55 → 1.19 µs/commit for the date-walk scaffold is a
**model, not a measurement**. The bar is **"not worse"** on `log()` medium, `log()` via
commit-graph and `describe()`; the gain is reported only if it clears run-to-run noise.
These rows exist on `main`, so the orchestrator's `npm run bench:ab -- main perf/closure-history-walks 2`
compares them normally — this part records local absolutes for both sides only if it
runs the benches itself.

### TDD steps

1. **RED — a linear history uses no fan-out.** `commit-date-walk.test.ts`: spy
   `Promise.allSettled`; walk a linear chain; assert the yielded sequence is unchanged
   **and** the spy was never called. Expected failure: called once per commit.
2. **RED — zero eligible parents enqueue nothing.** Assert `enqueueCommit` is not reached
   when every parent is already seen or in `until`. This is the `<= 1` boundary mutant's
   killer.
3. **RED — a rejecting single parent rethrows.** Assert the original error object (not a
   wrapper) surfaces, with its `.data` where it is a `TsgitError`.
4. **GREEN — date walk.** Add the two early returns; hoist the `frontier` closure out of
   the yield to one per walk. Run `commit-date-walk.test.ts:257-295` and
   `walk-commits-by-date.test.ts` and `describe`'s tests **unedited**.
5. **RED — whatchanged diffs outside the loop.** Spy `boundedMapFor`; assert it is called
   exactly once, with the selected commits in output order; assert order and `limit`
   semantics are byte-identical to today on a fixture with merges and a `before` filter.
6. **GREEN — whatchanged.**
7. **RED — range-diff releases blob content.** Assert `hydrate`'s return value has no
   `oldContent`/`newContent` keys (key-presence assertion), and that `rangeDiffEntries`
   over rendered patches produces the identical entries as today on the existing fixture.
8. **GREEN — range-diff**: move the two `.map(renderRangePatch)` calls into `hydrate`,
   change the domain signature, extend the domain barrel.
9. **REFACTOR** — `whatchanged`'s selection loop and its diff stage are two named steps,
   each under 20 lines; `enqueueParents` keeps its documented array-order comment for the
   `≥ 2` arm only.
10. **VERIFY the suppressions**: `describe.ts:280`, `walk-commits-by-date.ts:51,53`
    re-run, unedited.
11. **Surface gate** — `npm run docs:json`; expect an empty `reports/api.json` diff;
    commit it if not.

### Gate

```
npx vitest run test/unit/application/primitives/internal/commit-date-walk.test.ts test/unit/application/primitives/walk-commits-by-date.test.ts test/unit/application/commands/describe.test.ts test/unit/application/commands/whatchanged.test.ts test/unit/application/commands/range-diff.test.ts test/unit/domain/range-diff 2>&1 | tee /tmp/p10-vitest.log; echo $?
npx vitest run test/integration/whatchanged-interop.test.ts test/integration/range-diff-interop.test.ts 2>&1 | tee /tmp/p10-interop.log; echo $?
npm run check:types 2>&1 | tee /tmp/p10-types.log; echo $?
npx tsc --noEmit -p tsconfig.json 2>&1 | tee /tmp/p10-tsc.log; echo $?
./node_modules/.bin/biome check src/application/primitives/internal/commit-date-walk.ts src/application/commands/whatchanged.ts src/application/commands/range-diff.ts src/domain/range-diff/range-diff.ts src/domain/range-diff/index.ts test/unit/application/primitives/internal/commit-date-walk.test.ts test/unit/application/commands/whatchanged.test.ts test/unit/application/commands/range-diff.test.ts 2>&1 | tee /tmp/p10-biome.log; echo $?
npm run check:spelling 2>&1 | tee /tmp/p10-spell.log; echo $?
npm run docs:json 2>&1 | tee /tmp/p10-docs-json.log; echo $?; git diff --stat -- reports/api.json
```

### Commit

```
perf(history): skip the fan-out on single parents and release patch blobs early
```
