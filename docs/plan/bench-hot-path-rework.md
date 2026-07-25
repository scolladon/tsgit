# Plan — Rebuild the bench suite around hot paths

> Source: design doc `docs/design/bench-hot-path-rework.md` · ADRs `501–505`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema (`### Context`/`### TDD steps`/`### Gate`/`### Commit`).

## Scope & surface

Bench-suite + CI/tooling only. **No public library/command surface** — every new export
lives in `tooling/**` or `test/bench/**` (tooling-local, not a package re-export) or is a
data/prose file (`docs/perf/hot-paths.json`, `docs/understand/performance.md`, `ci.yml`).
So the Tier-1-command surface gates (barrel / facade / `reports/api.json` / doc-coverage /
browser-parity / README count) are **N/A**; `api.json` and doc-coverage do **not** move.
Each part restates "no public surface" so the implementer never chases a phantom gate.
Faithfulness matrix: **N/A** (ADR-226 / §Faithfulness) — fixtures are *inputs* to a
wall-clock measurement; no new git-observable state, refusal, or message.

## Dependency order (sequential, one shared worktree)

1. **Part 1** — extend `fixture-generator.ts` (foundation: `SMALL_FIXTURE`, deep-ancestry strategy, version bump).
2. **Part 2** — `tiered-bench.ts` helper + tier the plain-shape hot benches (`log`/`status`/`pack-read`) + carve the two non-registry micro-scenarios. Needs Part 1.
3. **Part 3** — tier the shape-bearing hot benches (`blame`/`describe`/`name-rev`). Needs Parts 1–2.
4. **Part 4** — non-hot medium benches (profiled reads + writes). Needs Part 1 (`MEDIUM_FIXTURE`).
5. **Part 5** — `hot-paths.json` registry + gate scoping (`operationOf`/`hotGatedEntries`) + unit tests + consistency check. Needs Parts 2–3 landed (the consistency check reads the tiered benches).
6. **Part 6** — CI comment prose + `performance.md`. Needs Part 5 (the registry it describes).

Parts 2–4 are all bench-file work; their per-part gate is *running* the bench green
(`npx vitest bench --run …`), not asserting. The genuinely TDD code surface is Part 5.

---

## Part 1 — Extend fixture-generator: SMALL + deep-ancestry tiers, version bump

### Context
No public surface (all symbols are `test/bench/support/**` exports, not package entries).

**File to edit:** `test/bench/support/fixture-generator.ts` (current, verified).
- `FIXTURE_GENERATOR_VERSION = 1` (line 25) — **bump to `2`**. This invalidates **all**
  cached tiers (`cacheDirFor` keys the cache dir on `${spec.label}-v${VERSION}`, line 108;
  `readCachedMeta` rejects a stale `version`, line 357). Consequence to state in the commit
  body-less world only via the code: the next bench run regenerates `medium` (~50 MB) once,
  and the nightly regenerates `large` (~500 MB) once; `bench.yml` keys its `actions/cache`
  on this file's hash so the bump propagates there. **Local part gate does NOT pay the
  medium/large regen** — the smoke test builds only ~50-commit fixtures (see Gate).
- `FixtureSpec` (lines 32–43): `label: 'medium' | 'large' | 'delta-chain'`,
  `strategy: 'multi' | 'evolving'`, `commits`, `blobs`, `blobBytes`, `deltaDepth?`,
  `deltaWindow?`. `BLOBS_PER_COMMIT = 4` (line 27) → a 50-commit multi fixture = 200 blobs.
- Existing exports reused unchanged: `MEDIUM_FIXTURE` (45), `LARGE_FIXTURE` (53),
  `DELTA_CHAIN_FIXTURE` (68), `ensureScaledFixture` (371), `ScaledFixture` (78),
  `maxChainDepthOid` (221), `gitEnv` (241), `runGit` (244), `runFastImport` (260),
  `generateMulti` (329, does `fast-import → checkout -f main → repack -ad --quiet`),
  `generateInto` (335), `streamFastImport` (134).

**Additions (concrete shape — keep cache keys unique so tiers never collide):**
- Broaden `FixtureSpec.label` to include `'small'` and the three deep-ancestry identities:
  `'small' | 'medium' | 'large' | 'delta-chain' | 'deep-ancestry-small' |
  'deep-ancestry-medium' | 'deep-ancestry-large'`. `label` stays the sole cache-dir
  discriminator (unique per fixture identity → no collision between `small` multi and
  `deep-ancestry-small`).
- Add `strategy: 'deep-ancestry'` to the strategy union.
- Export `SMALL_FIXTURE` = `{ label:'small', strategy:'multi', commits:50, blobs:200,
  blobBytes:2_560 }` (packed via `generateMulti`; ~<1 MB; 50 commits × 4 blobs = 200).
- Export deep-ancestry specs `DEEP_ANCESTRY_SMALL/MEDIUM/LARGE`
  (`strategy:'deep-ancestry'`, `blobBytes:256`, `blobs:1`). **Commit counts are
  shape-calibrated, NOT the multi 50/5000/50000** — blame cost is O(ancestry depth)
  (see Part 3's timeout risk): start `commits: 50 / 500 / 2000` respectively.
- New `streamDeepAncestryFastImport(stdin, spec)` mirroring `fixtures.ts`
  `setupDeepAncestryRepo`'s topology via fast-import: commit 0 writes `stable.txt` (one
  blob, message `seed stable.txt`); commits `1..spec.commits` each rewrite `churn.txt`
  (fresh blob, message `churn i`). Reuse `blobContent`/`writeChunk`/the header idiom from
  `streamFastImport` (134) / `streamEvolvingFastImport` (193). Total commits = `commits+1`.
- New `generateDeepAncestry(repoDir, spec)` = `runFastImport(…, streamDeepAncestryFastImport)
  → checkout -f main → repack -ad --quiet` (packed, exactly like `generateMulti`).
- Wire `generateInto` (335): `strategy === 'deep-ancestry'` → `generateDeepAncestry`, and
  its `firstBlobId` branch (346) → `runGit(repoDir, ['rev-parse', 'HEAD:stable.txt'])`
  (stable.txt is present throughout the deep ancestry). `headCommitId` via existing
  `rev-parse HEAD`.

**Isolation (injected contract):** `ensureScaledFixture` writes to `cacheRoot()` which honors
`XDG_CACHE_HOME` (line 102). The smoke test MUST set `XDG_CACHE_HOME` to a `mkdtemp` dir and
restore it after, so it never touches the shared `~/.cache/tsgit-bench` or the worktree.

### TDD steps
- **RED** — new `tooling/test/unit/fixture-generator.test.ts` (sibling of the existing
  `max-chain-depth-oid.test.ts`, which imports `../../../test/bench/support/fixture-generator.ts`
  — reuse that import path; runs in `test:unit`, coverage-excluded). Given/When/Then + AAA,
  `sut = ensureScaledFixture`. `describe.skipIf(process.env.STRYKER_MUTANT_ID !== undefined
  || !hasGit)` (probe `git --version` once in a `beforeAll`). In each test set
  `process.env.XDG_CACHE_HOME` to a fresh `mkdtemp`, `afterAll` restores + `rm -rf`.
  - Given `SMALL_FIXTURE`, When `ensureScaledFixture` runs, Then `headCommitId` matches
    `/^[0-9a-f]{40}$/`, `firstBlobId` matches `/^[0-9a-f]{40}$/`, and the cache dir holds a
    `*.pack` (packed). → **fails**: `SMALL_FIXTURE` is not exported (import/type error).
  - Given `DEEP_ANCESTRY_SMALL`, When it runs, Then `headCommitId` is 40-hex and
    `git -C <cwd> rev-parse HEAD:stable.txt` succeeds (assert `firstBlobId` is 40-hex).
    → **fails**: `deep-ancestry` strategy unhandled in `generateInto` (throws / no branch).
- **GREEN** — apply the additions above (label union, strategy, `SMALL_FIXTURE`, the three
  deep-ancestry specs, `streamDeepAncestryFastImport`, `generateDeepAncestry`, the
  `generateInto` wiring, version bump `1→2`).
- **REFACTOR** — factor the shared fast-import commit-header emission if
  `streamDeepAncestryFastImport` duplicates `streamFastImport`; keep functions <20 lines,
  early returns, no magic numbers (name the deep-ancestry counts as `const`s beside the
  existing `DELTA_CHAIN_*` block).

### Gate
`npx vitest run tooling/test/unit/fixture-generator.test.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/support/fixture-generator.ts tooling/test/unit/fixture-generator.test.ts`
(Smoke builds only ~50-commit fixtures under an isolated `XDG_CACHE_HOME` — fast, no
medium/large regen. `check:types` compiles the widened `FixtureSpec` against all call sites.)

### Commit
`test(bench): add small and deep-ancestry scaled fixtures and bump the generator version`

---

## Part 2 — Tiered helper + tier the plain-shape hot benches; carve the micro-scenarios

### Context
No public surface (bench files + `test/bench/support/tiered-bench.ts`, none package-reachable).

**New helper `test/bench/support/tiered-bench.ts`** (mirrors `scaled-bench.ts`, which it
depends on):
- Import `resolveScaledContext`, `scaledScenario` from `./scaled-bench.js`; `FixtureSpec`,
  `ScaledFixture` from `./fixture-generator.js`; `BenchComparison` from `./bench-dsl.js`.
- Export `interface TierSpecs { small; medium; large: FixtureSpec }`.
- Export `async tieredScenario(tiers: TierSpecs, whenThen: string, build: (fixture:
  ScaledFixture) => Promise<BenchComparison> | BenchComparison): Promise<void>` —
  build the tier list `[tiers.small, tiers.medium]`, push `tiers.large` **only** when
  `process.env.TSGIT_BENCH_LARGE !== undefined`; for each spec `const ctx = await
  resolveScaledContext(spec); scaledScenario(ctx, whenThen, build);`. `resolveScaledContext`
  already computes a per-spec `given` phrase (label-bearing → distinct describe titles →
  distinct gate keys per tier) and cleanly skips under Stryker / missing `git`.
- Export the two plain-shape tier records built from Part 1's specs:
  `MULTI_TIERS = { small: SMALL_FIXTURE, medium: MEDIUM_FIXTURE, large: LARGE_FIXTURE }`.

**`bench-dsl.ts` invariant (do NOT touch):** the two `bench()` names stay exactly
`tsgit` / `isomorphic-git` (lines 49–50); only describe titles change. Key format stays
`<relative-bench-file-path> > <describe title> > tsgit` (Part 5's `operationOf` parses the
leading path segment).

**Rewrite `test/bench/log.bench.ts`** (currently `setupSmallRepo(50)`-only) → tiered:
`const ctx not needed`; `await tieredScenario(MULTI_TIERS, 'When log() walks every commit,
Then compare tsgit against isomorphic-git', build)` where `build(fixture)` opens
`openRepository({cwd:fixture.cwd})`, `afterAll` disposes, `sut = () => repo.log()`,
`baseline = () => git.log({fs, dir:fixture.cwd, depth:fixture.spec.commits})`
(the current `log-scale.bench.ts` body is the template). **Delete `log-scale.bench.ts`.**

**Rewrite `test/bench/status.bench.ts`** → tiered CLEAN only (from `status-scale.bench.ts`
body): `tieredScenario(MULTI_TIERS, 'When status() scans the clean tree, Then compare tsgit
against isomorphic-git', …)`, `sut = repo.status()`, `baseline = git.statusMatrix({fs,
dir:fixture.cwd})`. **Delete `status-scale.bench.ts`.** Move the dirty variant out (below).

**New `test/bench/pack-read.bench.ts`** (basename `pack-read` → the registry op) — merge
`read-blob.bench.ts` (packed cold/warm parts) + `pack-read-scale.bench.ts`:
- Cold: `tieredScenario(MULTI_TIERS, 'When readBlob() reads from a cold pack, Then compare
  tsgit against isomorphic-git', build)` — fresh `openRepository` per `sut` call reading
  `fixture.firstBlobId as ObjectId`; `baseline = git.readBlob({fs,dir,oid:fixture.firstBlobId})`.
- Warm: second `tieredScenario(…, 'When readBlob() reads from a warm pack, …', build)` — one
  repo per tier, prime once, `afterAll` disposes.
- **Retain** the large-only spread scenario verbatim from `pack-read-scale.bench.ts`
  (lines 70–120: `SHARD_SIZE`/`spreadBlobPath`/`SPREAD_INDICES`/`resolveSpreadIds`, guarded
  by `if (process.env.TSGIT_BENCH_LARGE !== undefined)`). It stays under `pack-read.bench.ts`
  so its basename resolves to the hot op, but large is env-gated off in the PR job.
- **Delete `read-blob.bench.ts` and `pack-read-scale.bench.ts`.**

**New `test/bench/loose-read.bench.ts`** — the loose-object read micro-scenario (ADR-503,
kept explicitly). **Basename `loose-read` is deliberately NOT a registry op** so §D5 keeps it
out of the gate. One `benchScenario` (not tiered): a fresh small **loose** repo via
`setupSmallRepo({commits:50})` from `./fixtures.js`; cold path = fresh `openRepository` per
`sut` call reading `fixture.firstBlobId`; `baseline = git.readBlob(...)`; `afterAll` cleans up.
(Body = `read-blob.bench.ts` cold scenario, lines 20–39.)

**New `test/bench/status-dirty.bench.ts`** — the dirty-working-tree `status` variant.
**Basename `status-dirty` is deliberately NOT a registry op** (§D5: it must fall outside the
gate; the cached tier fixtures are read-only shared caches and cannot be dirtied). One
`benchScenario` using `setupSmallRepo({commits:50})` + `setupDirtyWorkingTree(fixture,25)`
from `./fixtures.js` (its own mutable tmpdir), `sut = repo.status()`, `baseline =
git.statusMatrix(...)`. (Body = `status.bench.ts` dirty scenario, current lines 41–63.)

**`test/bench/fixtures.ts`:** keep `setupSmallRepo`, `setupDirtyWorkingTree` (now used by the
two micro files). `setupDeepAncestryRepo` / `ensureCacheDir` are removed in Part 3 (their last
consumers disappear there) — leave them here for now to keep this part's diff green.

**Verified there are NO non-doc external references** to the deleted basenames — the
`test/bench/**/*.bench.ts` glob in `vitest.bench.config.ts` (include, line 6) and CI's
`test:bench` cover renames automatically; `bench-to-snapshot.ts` / `bench-summarize.ts` key
on `bench()` names, not file basenames.

### TDD steps
- **RED** — bench files have no unit tests; the "test" is *running the bench green*. Before
  writing the tiered bodies, a scratch run with the helper absent fails to resolve
  `./support/tiered-bench.js` (module-not-found) — that is the RED for the helper.
- **GREEN** — add `tiered-bench.ts`; rewrite `log`/`status`/`pack-read` onto it; add
  `loose-read` + `status-dirty`; delete the four superseded files. Run the Gate benches to
  green (each tier registers, runs, and emits `tsgit` + `isomorphic-git` rows).
- **REFACTOR** — collapse duplicated open/dispose/`afterAll` boilerplate across the tiered
  builds where it stays readable; keep `sut` named per the DSL.

### Gate
`npx vitest bench --run --config vitest.bench.config.ts test/bench/log.bench.ts test/bench/status.bench.ts test/bench/pack-read.bench.ts test/bench/loose-read.bench.ts test/bench/status-dirty.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/support/tiered-bench.ts test/bench/log.bench.ts test/bench/status.bench.ts test/bench/pack-read.bench.ts test/bench/loose-read.bench.ts test/bench/status-dirty.bench.ts test/bench/fixtures.ts`
(First bench run after Part 1's version bump regenerates `medium` once — minutes, then
cached; `TSGIT_BENCH_LARGE` unset so `small` + `medium` only. Expected, not a failure.)

### Commit
`test(bench): tier the log, status and pack-read benches on the shared generator`

---

## Part 3 — Tier the shape-bearing hot benches: blame, describe, name-rev

### Context
No public surface (bench files + a `scaled-bench.ts` phrase edit; nothing package-reachable).

**`test/bench/support/scaled-bench.ts` — extend `givenPhrase`** (module-private, lines 24–29).
It currently branches `strategy === 'evolving'` else the multi phrase (`commits`, `blobs`).
Add a `strategy === 'deep-ancestry'` branch → e.g. `Given a ${spec.label} deep-ancestry repo
(${spec.commits} commits)` (no `blobs` count — deep-ancestry's `blobs:1` is not a file count).
Distinct label per tier keeps describe titles / gate keys distinct.

**New `test/bench/blame.bench.ts`** (basename `blame` → registry op) — replaces
`blame-deep-ancestry.bench.ts`. Import a `DEEP_ANCESTRY_TIERS` record (assemble in this file
or export it from `tiered-bench.ts`): `{ small: DEEP_ANCESTRY_SMALL, medium:
DEEP_ANCESTRY_MEDIUM, large: DEEP_ANCESTRY_LARGE }`. `await tieredScenario(DEEP_ANCESTRY_TIERS,
'When blame() walks stable.txt, Then it stays O(path-depth) instead of flattening every
tree', build)`: `openRepository`, `afterAll` disposes, `sut = () => repo.blame('stable.txt')`,
**no baseline** (tsgit-only, per the current file's comment). **Delete
`blame-deep-ancestry.bench.ts`.**
- **TIMEOUT RISK — the load-bearing reason the deep-ancestry counts are small (Part 1).**
  `blame('stable.txt')` walks the full ancestry back to `stable.txt`'s root introduction, so
  cost ≈ O(commit count). `tooling/profile-registry.ts` (lines 39–43) records that a
  ~200-deep blame samples for *tens of seconds* and a ~5000-deep blame *takes minutes*. The
  bench `testTimeout` is **120 s** (`vitest.bench.config.ts:12`). So deep-ancestry medium
  MUST stay modest (start 500; the Gate proves it completes sampling under 120 s — lower it
  if it does not). Large (2000) only registers under `TSGIT_BENCH_LARGE` (off in the PR/Gate
  run). Do **not** set deep-ancestry medium to the multi 5000 — it will time out.

**Rewrite `test/bench/describe.bench.ts`** (currently `resolveScaledContext()` medium-only,
lines 39–56) → tiered on `MULTI_TIERS`. Keep the `ensureNearTag` preamble verbatim
(lines 19–37: env-scrubbed `git tag -f -a bench-describe-near … HEAD~10`, idempotent, moves
no fixture branch). Call it inside `build(fixture)` on `fixture.cwd` before opening the repo;
`sut = () => repo.describe()`, no baseline. describe early-terminates at `HEAD~10`, so cost is
O(distance) at every tier (small's 50 commits ≥ 10 — safe).

**Rewrite `test/bench/name-rev.bench.ts`** (currently medium-only, lines 66–83) → tiered on
`MULTI_TIERS`. Keep `benchEnv`/`gitOut`/`ensurePrunableTaggedTip` verbatim (lines 21–64:
`commit-tree` on a dated dangling commit + `tag -f`, idempotent, no fixture-branch move). Call
`ensurePrunableTaggedTip(fixture.cwd)` inside `build`, `sut = () => repo.nameRev(target)`, no
baseline. Date-cutoff pruning → O(distance) at every tier.

**Shared-cache safety (already-established, unchanged):** the tag/`commit-tree` preambles
mutate the shared cached fixtures (now also `small`), but only add tags / dangling commits —
`HEAD`, working tree, and pack are untouched, so `log`/`status`/`pack-read` reading the same
cache are unaffected. This is the exact posture the current medium-fixture benches already
rely on.

**`test/bench/fixtures.ts` cleanup:** remove `setupDeepAncestryRepo` (its only consumer,
`blame-deep-ancestry.bench.ts`, is deleted here) and `ensureCacheDir` **iff** a repo-wide grep
confirms no remaining references (avoid dead code — CLAUDE.md). Keep `setupSmallRepo` /
`setupDirtyWorkingTree` (Part 2's micro files use them).

### TDD steps
- **RED** — running `test/bench/blame.bench.ts` before the deep-ancestry specs are wired would
  fail to resolve them; the pre-Green scratch run is the RED signal for the tier records.
- **GREEN** — extend `givenPhrase`; add `blame.bench.ts` (delete the old file); tier
  `describe`/`name-rev` keeping preambles; clean `fixtures.ts`. Run the Gate benches green,
  confirming the medium `blame` completes within `testTimeout` (drop the medium count if not).
- **REFACTOR** — hoist `DEEP_ANCESTRY_TIERS` to `tiered-bench.ts` if `blame.bench.ts` is its
  only assembler and that reads cleaner; keep preambles single-purpose.

### Gate
`npx vitest bench --run --config vitest.bench.config.ts test/bench/blame.bench.ts test/bench/describe.bench.ts test/bench/name-rev.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/blame.bench.ts test/bench/describe.bench.ts test/bench/name-rev.bench.ts test/bench/support/scaled-bench.ts test/bench/fixtures.ts`
(First run builds the three deep-ancestry tiers + reuses the cached `medium`; confirm the
medium `blame` sample finishes under 120 s.)

### Commit
`test(bench): tier blame, describe and name-rev on their representative shapes`

---

## Part 4 — Non-hot medium benches: profiled reads and writes

### Context
No public surface. All new benches are **non-hot / non-gated** — their basenames are NOT in
the registry (§D5), so Part 5's `operationOf` filter drops them; none use `tieredScenario`,
so Part 5's consistency check ignores them. This realises ADR-504 ("every profiled command
has a bench; non-hot = medium only").

**Reads (loop-in-place on `MEDIUM_FIXTURE`, like `log`/`status`).** One file per op, each a
single `benchScenario` (medium-only, NOT tiered). Resolve once via `const ctx = await
resolveScaledContext(MEDIUM_FIXTURE)` + `scaledScenario(ctx, whenThen, build)` from
`./support/scaled-bench.js`. Invocations are pinned by `tooling/profile-registry.ts`
`READ_WORKLOADS` (lines 168–198) — copy them exactly:
- `test/bench/show.bench.ts` — `sut = () => repo.show('HEAD')`.
- `test/bench/diff.bench.ts` — `sut = () => repo.diff({ from:'HEAD~1', to:'HEAD' })`.
- `test/bench/cat-file.bench.ts` — `sut = () => repo.catFile({ ids:[fixture.headCommitId] })`.
- `test/bench/rev-parse.bench.ts` — `sut = () => repo.revParse('HEAD')`.
  All `openRepository({cwd:fixture.cwd})` once, `afterAll` disposes, no baseline
  (tsgit-only; these have no isomorphic-git analog in the current suite).

**Writes need a bench-native scratch factory — DO NOT import `tooling/profile-scratch-repo.ts`.**
That factory dynamically imports `dist-profile/esm/index.node.js` (lines 17–42), a
*profiling build* that `test:bench` does **not** produce (`test:bench` wireit deps = `check:types`
only; CI runs `npm run build`, not `build:profile`). Importing it into a bench would fail at
run time. Instead add **`test/bench/support/write-scratch.ts`** that replicates the three
topologies using the bench-resolvable `openRepository` from `../../src/index.node.js` and
`AuthorIdentity` from `../../src/domain/objects/index.js` (`{ name, email, timestamp,
timezoneOffset:'+0000' }` — the `timezoneOffset` field is required). Export
`ScratchRepo = { cwd; repo; dispose(): Promise<void> }` and three builders mirroring
`profile-scratch-repo.ts` (lines 59–100):
- `buildCommitScratch(env)` — `mkdtemp → openRepository → repo.init()`, write `a.txt`,
  `repo.add(['a.txt'])` (staged, ready for the measured `commit`).
- `buildAddScratch(env)` — init, write unstaged `a.txt` + `b.txt` (ready for `add`).
- `buildMergeScratch(env)` — init, root commit (`a.txt`+`b.txt`), branch `side`, checkout
  `side`, edit+commit `b.txt`, checkout `main`, edit+commit `a.txt` (HEAD on `main`, ready
  for a non-fast-forward `merge.run({rev:'side'})`). Reuse a pinned `AuthorIdentity` for
  byte-stability.

**Write benches — fresh scratch per `sut` iteration (the `clone-small-repo.bench.ts` precedent,
lines 51–91: build inside `sut`, collect dirs, bulk-clean in `afterAll`).** commit and merge
CANNOT loop in place (state mutates); build the scratch inside `sut`, run the write, push the
scratch to a list disposed in `afterAll`. Invocations pinned by `WRITE_WORKLOADS`
(`profile-registry.ts` lines 209–236):
- `test/bench/commit.bench.ts` — `buildCommitScratch` → `repo.commit({ message:'bench',
  author, committer })`.
- `test/bench/add.bench.ts` — `buildAddScratch` → `repo.add([], { all:true })`.
- `test/bench/merge.bench.ts` — `buildMergeScratch` → `repo.merge.run({ rev:'side',
  fastForward:'never', author, committer })`.
  All tsgit-only, non-gated. **Accepted caveat:** the reported median includes the
  per-iteration scratch build — acceptable because these are advisory, non-gated coverage
  (ADR-504/488), faithful to the 26.3 factory's own fresh-per-iteration model; no DSL
  setup/teardown extension is introduced.

`env` for the builders: reuse the `gitEnv()`-style GIT_*-scrub only if a builder spawns `git`
(these use tsgit's own write path, so a plain `process.env` pass-through is fine; keep the
`env` param for signature-parity with the factory but it may be unused → prefix `_env` to
satisfy biome if so).

### TDD steps
- **RED** — running any write bench that imports `tooling/profile-scratch-repo.ts` fails
  (dist-profile absent) — proving the bench-native `write-scratch.ts` is required; a
  pre-Green scratch run of `commit.bench.ts` referencing the not-yet-written helper is
  module-not-found.
- **GREEN** — add `write-scratch.ts`; add the four read benches + three write benches. Run
  the Gate benches green.
- **REFACTOR** — extract the shared `mkdtemp → openRepository → init` preamble into one
  `newScratch` (as the factory does), keep each builder <20 lines.

### Gate
`npx vitest bench --run --config vitest.bench.config.ts test/bench/show.bench.ts test/bench/diff.bench.ts test/bench/cat-file.bench.ts test/bench/rev-parse.bench.ts test/bench/commit.bench.ts test/bench/add.bench.ts test/bench/merge.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/support/write-scratch.ts test/bench/show.bench.ts test/bench/diff.bench.ts test/bench/cat-file.bench.ts test/bench/rev-parse.bench.ts test/bench/commit.bench.ts test/bench/add.bench.ts test/bench/merge.bench.ts`

### Commit
`test(bench): add medium non-hot read and write benches for the profiled commands`

---

## Part 5 — Hot-path registry, gate scoping, unit tests + consistency check

### Context
No public surface: `operationOf` / `hotGatedEntries` / `parseHotOperations` are
**tooling-local** exports of `tooling/bench-check.ts` (never re-exported from a package entry
— confirm no `src/**` or barrel edit); `docs/perf/hot-paths.json` is a data file. `api.json`
and doc-coverage do not move. `tooling/**` is coverage- **and** mutation-excluded (Stryker
mutates `src/**` only) — no coverage/mutation obligation; tests are example-based and
CLAUDE.md-mutation-resistant by hand.

**New `docs/perf/hot-paths.json`** (beside `docs/perf/baseline.json`; `docs/perf/` verified
NOT git-ignored). Shape (design §D1):
```
{
  "generatedFrom": "Phase-26 revealed optimisation effort (log/status/pack-read/blame/describe/name-rev) cross-checked against the nightly bench.yml median-ms ranking; see docs/adr/501-hot-path-picking-methodology.md",
  "majorVersion": "3",
  "hotOperations": ["log", "status", "pack-read", "blame", "describe", "name-rev"]
}
```
- `generatedFrom` is an **honest provenance string** — we cannot run a real nightly in the
  worktree, so it cites the derivation basis (revealed-effort + nightly ranking per ADR-501),
  **never a fabricated CI run-id**.
- `majorVersion:"3"` matches `package.json` version `3.0.0` (the per-major refresh cadence).
- `hotOperations` maps 1:1 to the tiered bench basenames from Parts 2–3
  (`log`/`status`/`pack-read`/`blame`/`describe`/`name-rev`).

**Edit `tooling/bench-check.ts`** (verified current):
- Existing: `TSGIT_KEY_SUFFIX = ' > tsgit'` (18); `gatedEntries(entries)` filters that suffix
  (20); `readReport(filePath)` = `gatedEntries(toSnapshotEntries(JSON.parse(read)))` (77);
  `main()` (140) reads two argv paths, compares, emits, exits; `main().catch` logs + exit 1
  (165). Imports only `./bench-to-snapshot.ts` (14). `SnapshotEntry` from there.
- Add pure `export const operationOf = (key: string): string`: take the segment before the
  first ` > ` (`key.split(' > ')[0]`), `path.basename` it, strip a trailing `.bench.ts`;
  **if that segment does not end with `.bench.ts`, return `''`** (a defined, tested result —
  `''` is not in `hotOperations`, so a malformed key is silently non-hot, matching §D5/the
  error-semantics "dropped, never errored" posture). `path` is already imported (12).
- Add pure `export const parseHotOperations = (parsed: unknown): readonly string[]`: validate
  `parsed` is an object whose `hotOperations` is a `string[]`; else **throw**
  `new Error('hot-paths.json: "hotOperations" must be an array of operation strings')`
  (specific message, no swallow). Returns the array.
- Add pure `export const hotGatedEntries = (entries: readonly SnapshotEntry[], hot: readonly
  string[]): readonly SnapshotEntry[]` = `gatedEntries(entries).filter(e => hot.includes(
  operationOf(e.name)))` — reuse `gatedEntries` for the `> tsgit` guard (keeps that guard
  independently tested), then the hot filter. `compareToBaseline` is unchanged.
- Change `readReport(filePath, hot)` to call `hotGatedEntries(toSnapshotEntries(…), hot)`.
- In `main()`: compute `const REGISTRY = path.join(path.resolve(path.dirname(fileURLToPath(
  import.meta.url)), '..'), 'docs', 'perf', 'hot-paths.json')` (bench-check.ts is in
  `tooling/`, `..` = repo root; `fileURLToPath` already imported, 13). Read + `JSON.parse` +
  `parseHotOperations` → `hot`; pass `hot` to both `readReport` calls. A missing / unreadable
  / non-JSON registry throws through the existing `main().catch` (loud, exit 1, tolerated by
  CI `continue-on-error`) — **no silent gate-everything/gate-nothing fallback**; a
  structurally-invalid registry throws via `parseHotOperations`.

**Extend `tooling/test/unit/bench-check.test.ts`** (verified — Given/When/Then, AAA, `sut =
<fn under test>`, `entry(name,value)` helper at line 12). Add describes:
- `operationOf`: `test/bench/log.bench.ts > Given … > tsgit` → `'log'`;
  `test/bench/pack-read.bench.ts > … > tsgit` → `'pack-read'`; a key with no `.bench.ts` first
  segment (`'weird > tsgit'`) → `''`. Assert exact strings (kills StringLiteral mutants).
- `hotGatedEntries` (guard-isolation — prove each filter **separately**, per CLAUDE.md):
  - a `tsgit` entry whose op ∈ hot (`test/bench/log.bench.ts > … > tsgit`) **survives**;
  - a `tsgit` entry whose op ∉ hot (`test/bench/show.bench.ts > … > tsgit`, and a
    `test/bench/status-dirty.bench.ts > … > tsgit`) is **dropped**;
  - an `isomorphic-git` entry whose op **is** hot
    (`test/bench/pack-read.bench.ts > … > isomorphic-git`) is dropped by the `> tsgit` guard
    **before** the hot filter (proves the suffix guard fires independently).
  - Assert the kept/dropped **set** with `toEqual` on survivors (not a length-only check).
- `parseHotOperations`: valid object → returns the array (assert `toEqual`); missing
  `hotOperations` → throws; `hotOperations` not an array / not all strings → throws — assert
  the `.message` DATA via try/catch (not `toThrow(Error)` alone).
- Property test is **optional** (§Test strategy — `hotGatedEntries` is a lens-2 filter but
  examples read clearer): add a case to the existing
  `tooling/test/unit/bench-check.properties.test.ts` ONLY if the example sweep proves
  unwieldy; if added, state invariants (idempotence `gate(gate)≡gate`; hot-op always
  survives; non-hot never does) — never re-implement the filter as its own oracle.

**New `tooling/test/unit/hot-paths-consistency.test.ts`** (runs in `test:unit`,
coverage-excluded; deterministic, no `git`) — the drift guard (§Error semantics):
- Read `docs/perf/hot-paths.json` (fs, resolved from repo root) → `hotOperations`.
- Scan `test/bench/*.bench.ts`: the set of files whose source contains `tieredScenario(`,
  mapped to `basename` without `.bench.ts` (the tiered bench set).
- Assert `new Set(tieredBasenames)` deep-equals `new Set(hotOperations)` — every hot op has a
  tiered bench AND no tiered bench is absent from the registry. A drift fails here, in the
  PR, before CI ever runs the gate.

### TDD steps
- **RED** — add the `operationOf` / `hotGatedEntries` / `parseHotOperations` describes and the
  consistency test first; they fail to import the not-yet-exported helpers (compile/type
  error) and the consistency test fails until `hot-paths.json` exists and matches Parts 2–3.
- **GREEN** — create `hot-paths.json`; implement the three pure helpers + the `readReport`/
  `main()` wiring in `bench-check.ts`. Tests pass.
- **REFACTOR** — keep helpers tiny/pure; ensure `main()`'s registry read stays a thin I/O
  shell over the pure `parseHotOperations` (so the malformed-structure path is the pure,
  unit-tested throw, not an fs concern).

### Gate
`npx vitest run tooling/test/unit/bench-check.test.ts tooling/test/unit/hot-paths-consistency.test.ts && npm run check:types && ./node_modules/.bin/biome check tooling/bench-check.ts tooling/test/unit/bench-check.test.ts tooling/test/unit/hot-paths-consistency.test.ts`

### Commit
`feat(bench-check): scope the regression gate to a hot-path registry`

---

## Part 6 — CI comment prose + performance doc

### Context
No public surface; docs/CI prose only — **no logic change**. The tool self-scopes to hot paths
via the registry (Part 5); the `benchmark-compare` job structure is untouched.

- **`.github/workflows/ci.yml` → `benchmark-compare`** (comment-only): the job's descriptive
  comment currently reads `… tsgit-scoped (isomorphic-git rows excluded), threshold N ≈ 10%`.
  Update the prose to say the gate is **hot-path-scoped (all CI-run tiers)** — it now compares
  only the hot operations in `docs/perf/hot-paths.json` across every CI-run tier (small +
  medium; large stays env-gated off). Change **no** step, env, `run:`, or `continue-on-error`.
  `bench.yml`, `benchmark-snapshot`, and `gh-pages` stay untouched (the `test/bench/**` globs
  already cover the renamed files).
- **`docs/understand/performance.md`** — add a line (near the Phase-26.5 "Regression gate"
  roadmap bullet, ~line 76, which already describes `bench-check.ts`) stating the gate is now
  **hot-path-scoped**: it compares only the operations in `docs/perf/hot-paths.json`, the list
  is derived from absolute nightly `bench.yml` timing cross-checked against the Phase-26
  revealed optimisation effort, and it is **re-derived each major version** (point at
  `hot-paths.json`). Prose may reference ADR-501/505 (docs prose MAY cite ADRs; source/test
  code must not). Keep the "advisory / `continue-on-error`" framing intact.

**Known cosmetic consequence to leave documented behaviour-wise (already covered by the
design's Risks, no code needed):** the bench-file renames start fresh `gh-pages` trend series
(`github-action-benchmark` keys on the snapshot `name`) — a one-time discontinuity, not a CI
failure (`fail-on-alert:false`).

### TDD steps
- **RED** — n/a (docs/CI prose has no test). The "failing" precondition is that
  `performance.md` and the CI comment still describe the old `tsgit`-only scope.
- **GREEN** — edit the CI comment prose + add the `performance.md` line.
- **REFACTOR** — n/a.

### Gate
`npm run check:spelling && npm run check:types`
(No touched tests and no TS logic — `check:spelling` covers the doc prose; `check:types` is a
trivially-green backstop confirming nothing TS was disturbed. The CI YAML change is
comment-only. `npm run validate` at the phase boundary is the final backstop.)

### Commit
`docs(perf): document the hot-path-scoped benchmark gate and annotate CI`
