# Phase 15 — Bench + observability follow-ups

Design for the six Phase 15 backlog items. They share one theme — make
tsgit's performance story **measurable at scale, on every platform, and
visible over time** — but they are otherwise independent slices.

| Item | Summary |
|------|---------|
| 15.1 | "Medium" bench fixture — 5k commits / 20k blobs / ~50 MB, cached |
| 15.2 | "Large" bench fixture — 50k commits / 200k blobs / ~500 MB, cached |
| 15.3 | `node --prof` profiling captures for log / status / pack-read |
| 15.4 | Per-OS mutation testing on macOS + Windows (closes 11.2 `[~]`) |
| 15.5 | Bench DSL wrapper enforcing Given/When/Then + `sut` naming |
| 15.6 | Re-enable the `benchmark-snapshot` CI job (raw.json → action schema) |

## 1. Current state (research)

- **Bench harness:** `vitest.bench.config.ts` runs `test/bench/**/*.bench.ts`,
  emits `reports/benchmarks/raw.json`. Four bench files exist:
  `log` (50 commits), `status` (clean + dirty-25), `read-blob` (cold + warm),
  `clone-small-repo` (vs `git-http-backend`).
- **Fixtures:** `test/bench/fixtures.ts` → `setupSmallRepo({ commits })` builds a
  synthetic repo in the OS tmpdir via the tsgit API on every run. Committed
  fixture `test/fixtures/clone-source/source.git` (5 commits, 92 KB) is
  `git`-CLI-built by `scripts/regenerate-clone-fixtures.sh`.
- **Summary:** `scripts/bench-summarize.ts` converts raw.json → `summary.md`
  (tsgit vs isomorphic-git table).
- **CI:** `ci.yml` `benchmark-compare` job (PR base-vs-PR, posts a comment);
  `bench.yml` nightly cron uploads artifacts. The `benchmark-snapshot` job is
  **disabled** (comment block in `ci.yml` Stage 7) — `github-action-benchmark@v1`
  rejects the vitest output shape.
- **Mutation:** `stryker.config.json` (vitest runner, mutates `src/**`);
  `ci.yml` `mutation` job runs `runs-on: ubuntu-latest` only. ADR-044 explicitly
  deferred per-OS mutation to "Phase 15.4".
- **Coverage scope:** `vitest.config.ts` `coverage.include` is `src/**` only.
  Everything Phase 15 adds lives in `scripts/`, `test/bench/`, or
  `.github/workflows/` — **no `src/` code, so the 100%-coverage and mutation
  gates do not expand.** The one piece with real branching logic (the 15.6
  converter) still gets a dedicated unit test for correctness.

## 2. Item designs

### 2.1 Fixture generator (15.1 / 15.2)

A deterministic generator builds medium/large repos **once** and caches them
under `~/.cache/tsgit-bench`, keyed by spec + generator version.

**Why `git fast-import`, not the tsgit API:** `setupSmallRepo` writes 50
commits via `repo.add` + `repo.commit` — fine at 50, far too slow at 50 000
(each commit rewrites the index). `git fast-import` ingests a commit stream in
seconds and the result is a normal git repo tsgit reads unchanged — the same
trust boundary as the existing `git`-CLI-built `clone-source` fixture.

The generator produces a **non-bare repo with the working tree and index
materialized** (`git init` → `fast-import` → `git checkout -f` → `git repack
-ad`). Three properties this gives:
- `status-scale.bench.ts` needs a real working tree + index — `status`
  compares the filesystem against the index, so a bare object store would not
  exercise it.
- `repack -ad` collapses loose objects into one pack so the pack-read benches
  hit the **pack reader** (fanout binary search + delta cache) — realistic and
  feeding 15.3's pack-read profile.
- The cached directory is a complete, openable repo for `openRepository`.

```ts
// test/bench/support/fixture-generator.ts

/** Bumped whenever the fixture shape changes — invalidates stale caches. */
export const FIXTURE_GENERATOR_VERSION = 1;

export interface FixtureSpec {
  readonly label: 'medium' | 'large';
  readonly commits: number;
  readonly blobs: number;
  readonly blobBytes: number; // ~2.5 KiB → 20k blobs ≈ 50 MB
}

export const MEDIUM_FIXTURE: FixtureSpec = {
  label: 'medium', commits: 5_000, blobs: 20_000, blobBytes: 2_560,
};
export const LARGE_FIXTURE: FixtureSpec = {
  label: 'large', commits: 50_000, blobs: 200_000, blobBytes: 2_560,
};

export interface ScaledFixture {
  readonly cwd: string;          // cached repo path (do NOT delete)
  readonly headCommitId: string;
  readonly firstBlobId: string;
  readonly spec: FixtureSpec;
}

/**
 * Returns the cached fixture, generating it on first use. Throws
 * `FixtureUnavailableError` when the `git` CLI is absent so callers can
 * `skipIf` rather than fail.
 */
export const ensureScaledFixture: (spec: FixtureSpec) => Promise<ScaledFixture>;
```

- **Cache path:** `${XDG_CACHE_HOME ?? ~/.cache}/tsgit-bench/<label>-v<version>/`.
  A sidecar `meta.json` records `{ version, headCommitId, firstBlobId, spec }`;
  presence + matching version = cache hit. The cached repo is **never deleted**
  by benches (unlike the tmpdir small fixture) — it is the cache.
- **Determinism:** fixed author identity + monotonic timestamps. Blob content
  is **deterministic pseudo-random** — a seeded xorshift PRNG keyed by the
  blob index fills `blobBytes` of high-entropy data. Low-entropy padding
  (`payload <n>` repeated) would compress to almost nothing, making the pack
  tiny and the pack-read bench unrepresentative; seeded PRNG content keeps the
  pack realistically sized while staying reproducible. Same inputs → same
  logical repo. Pack bytes may vary across `git` versions; benches measure
  read time, not byte-identity, so that is acceptable.
- **Seed ids:** after import + repack the generator runs `git rev-parse HEAD`
  for `headCommitId` and `git rev-parse HEAD:<first-file>` for `firstBlobId`,
  persisting both in `meta.json` so cache hits skip the `git` round-trip.
- **Streaming:** the fast-import stream is piped to the child's stdin
  incrementally — never materialise a 500 MB string.
- **CLI wrapper:** `scripts/gen-bench-fixture.ts` (`npm run bench:fixture --
  medium|large`) lets a developer pre-warm the cache before profiling.

### 2.2 Scaled bench scenarios (15.1 / 15.2)

Three new bench files exercise the hot paths against a scaled fixture:

- `test/bench/log-scale.bench.ts` — `repo.log()` walking all commits.
- `test/bench/status-scale.bench.ts` — `repo.status()` on a clean tree.
- `test/bench/pack-read-scale.bench.ts` — `repo.primitives.readBlob()` random
  blobs from the pack (cold + warm).

Each `skipIf`s when the fixture is unavailable (no `git` CLI / generation
failed) — identical gate style to `clone-small-repo.bench.ts`.

**One file, fixture chosen by environment.** Each `*-scale.bench.ts` selects
its spec at module load: `MEDIUM_FIXTURE` by default, `LARGE_FIXTURE` when
`TSGIT_BENCH_LARGE=1` is set. No duplicated bench files — the large run is the
same code against a bigger cached repo.

**Large fixture (15.2) is opt-in.** Generating + benching a 500 MB repo on
every CI run is prohibitive, so `TSGIT_BENCH_LARGE` is set only for local
scale checks and manual `workflow_dispatch`. The medium fixture runs in the
nightly `bench.yml`, with the cache directory restored via `actions/cache`
keyed on `FIXTURE_GENERATOR_VERSION`. See ADR-054.

### 2.3 Profiling driver (15.3)

`scripts/profile.ts` (`npm run profile`) captures a V8 CPU profile for each
hot path against the **medium** fixture:

1. For each path in `['log', 'status', 'pack-read']`, spawn a child
   `node --prof --prof-sampling-interval=200` running a minimal harness that
   opens the cached medium fixture and exercises that one operation in a loop.
2. Run `node --prof-process` on the emitted `isolate-*.log`.
3. Write the digest to `reports/profiles/<path>.txt`; clean up the raw
   `isolate-*.log`.

`reports/profiles/` is **git-ignored** — captures are host-specific and
regenerated on demand, so committing them would be noise. This is a
design-doc decision, not an ADR (no architectural alternative worth
recording). If the medium fixture cannot be built the script prints a clear
message and exits non-zero so the developer knows to install `git`.

### 2.4 Per-OS mutation CI (15.4)

ADR-044 deferred per-OS mutation to 15.4. The decision (ADR-055): a **nightly**
cron workflow, **not** a per-PR job.

- New `.github/workflows/mutation-os.yml`: `schedule` cron + `workflow_dispatch`,
  `strategy.matrix.os: [macos-latest, windows-latest]`, runs
  `npm run test:mutation` (full, non-incremental — nightly has the time
  budget), `timeout-minutes: 90`, uploads `reports/mutation/` as an artifact
  per OS. The cron fires offset from `bench.yml` (`14 3 * * *`) so the two
  heavy nightly jobs do not contend for the runner pool.
- Per-PR mutation stays Linux-only in `ci.yml` (unchanged). Rationale: a per-PR
  ×3-OS mutation matrix would triple the slowest merge-gating stage (~45 min →
  ~135 min of runner time); nightly per-OS catches platform-specific surviving
  mutants without taxing every PR. This satisfies 11.2's intent — per-OS
  mutation *exists and runs* — and lets 11.2 flip to `[x]`.
- Stryker is OS-portable (vitest runner, `tempDirName` is relative). No config
  change needed beyond CI.

### 2.5 Bench DSL wrapper (15.5)

A thin wrapper over vitest `describe`/`bench` so bench call sites read with the
project's Given/When/Then discipline and name the system-under-test `sut`.

```ts
// test/bench/support/bench-dsl.ts

interface BenchComparison {
  /** The tsgit code path under measurement — bound to `sut` at the call site. */
  readonly sut: () => Promise<void> | void;
  /** The isomorphic-git baseline. */
  readonly baseline: () => Promise<void> | void;
}

/**
 * Declares a bench scenario. `given` is the fixture/context phrase,
 * `whenThen` the action + expectation phrase. Expands to a vitest
 * `describe(`${given} ${whenThen}`)` with two `bench()` calls named
 * `tsgit` / `isomorphic-git` (names kept stable — bench-summarize.ts and
 * benchmark-compare key on them).
 */
export const benchScenario: (
  given: string,
  whenThen: string,
  build: () => Promise<BenchComparison> | BenchComparison,
) => void;
```

The wrapper keeps the `tsgit` / `isomorphic-git` bench **names** unchanged —
`bench-summarize.ts`, the `benchmark-compare` job, and 15.6's converter all key
on them. What changes is the *describe title* (now `Given … When … Then …`) and
the call-site shape (`sut` is the named tsgit closure). The four existing bench
files are migrated; the new scaled benches use it from the start.

No unit test: the wrapper is a pure passthrough to vitest's API — its contract
is "the bench files still run and still emit `tsgit`/`isomorphic-git` rows",
which `npm run test:bench` verifies directly.

### 2.6 Benchmark-snapshot converter + CI re-enable (15.6)

`scripts/bench-to-snapshot.ts` converts `reports/benchmarks/raw.json` to the
`customSmallerIsBetter` schema `github-action-benchmark@v1` expects.

```ts
// scripts/bench-to-snapshot.ts

interface SnapshotEntry {
  readonly name: string;   // "<scenario> > <tsgit|isomorphic-git>"
  readonly unit: 'ms';
  readonly value: number;  // median (fallback mean) runtime, smaller = better
}

/** Pure — unit-tested. Flattens raw.json groups → snapshot entries. */
export const toSnapshotEntries: (raw: RawReport) => SnapshotEntry[];
```

The module exports `toSnapshotEntries` **and** runs a `main()` when executed
directly. `main()` is guarded by an
`import.meta.url === pathToFileURL(process.argv[1]).href` check so importing
the module from the unit test does not trigger the file read / `process.exit`
(`bench-summarize.ts` runs `main()` unconditionally — that pattern cannot be
copied here because this module is also imported).

- **Metric:** median runtime in ms (fallback to mean) — matches what
  `bench-summarize.ts` already reports as the headline number, and
  `customSmallerIsBetter` treats smaller as better. ms-per-op, not ops/s, so
  the action's regression alerts read intuitively.
- **Naming:** `"<group fullName> > <bench name>"` — stable, unique, groups the
  tsgit/baseline pair under one scenario in the gh-pages chart.
- **CI:** the disabled `benchmark-snapshot` block in `ci.yml` Stage 7 is
  replaced with a real job — on push to `main`: `npm run test:bench` →
  `node scripts/bench-to-snapshot.ts` → `benchmark-action/github-action-benchmark@v1`
  with `tool: customSmallerIsBetter`, `auto-push: true` to gh-pages,
  `alert-threshold: 150%`, `comment-on-alert: true`. Needs `contents: write`
  (escalated locally on the job, matching the existing permission pattern).
- **Schema types:** `bench-to-snapshot.ts` declares its own minimal
  `RawReport`-shaped interface — the converter only reads `files → groups →
  benchmarks`. It does not import from `bench-summarize.ts`; the two scripts
  independently own their view of the external vitest JSON, which avoids
  editing the working `bench-summarize.ts` for no functional gain.
- **Unit test:** `test/unit/scripts/bench-to-snapshot.test.ts` exercises
  `toSnapshotEntries` against a fixture raw.json — empty input, single group,
  median-vs-mean fallback, multi-group flattening.

## 3. Module structure

```
test/bench/
├── support/
│   ├── http-backend-server.ts      (existing)
│   ├── bench-dsl.ts                (NEW — 15.5)
│   └── fixture-generator.ts        (NEW — 15.1/15.2)
├── fixtures.ts                     (existing — small fixture)
├── log.bench.ts                    (migrate → DSL)
├── status.bench.ts                 (migrate → DSL)
├── read-blob.bench.ts              (migrate → DSL)
├── clone-small-repo.bench.ts       (migrate → DSL)
├── log-scale.bench.ts              (NEW — 15.1)
├── status-scale.bench.ts           (NEW — 15.1)
└── pack-read-scale.bench.ts        (NEW — 15.1)

scripts/
├── bench-summarize.ts              (existing)
├── gen-bench-fixture.ts            (NEW — 15.1/15.2 CLI)
├── profile.ts                      (NEW — 15.3)
└── bench-to-snapshot.ts            (NEW — 15.6)

test/unit/scripts/
└── bench-to-snapshot.test.ts       (NEW — 15.6 converter test)

.github/workflows/
├── ci.yml                          (re-enable benchmark-snapshot — 15.6)
├── bench.yml                       (add medium-fixture cache step — 15.1)
└── mutation-os.yml                 (NEW — 15.4)
```

New `package.json` scripts: `bench:fixture` (15.1/15.2), `profile` (15.3).

## 4. Testing strategy

- **15.1/15.2 generator:** exercised end-to-end by the scaled bench files —
  if generation is broken, `test:bench` skips or fails loudly. No `src/` code,
  so no coverage gate. A fast smoke path: `gen-bench-fixture.ts` run with a
  tiny override spec in local dev.
- **15.3 profiler:** a script; verified by running `npm run profile` locally
  and confirming three non-empty digests.
- **15.4:** CI-only; verified by a `workflow_dispatch` run on the branch.
- **15.5 DSL:** verified by `npm run test:bench` still emitting every
  `tsgit`/`isomorphic-git` row after migration.
- **15.6 converter:** TDD unit test (`toSnapshotEntries`) — the only piece with
  branching logic. The CI job is verified by a `workflow_dispatch` / push dry-run.

`npm run validate` must stay green throughout — none of these changes touch
`src/`, so coverage stays 100% and the mutation surface is unchanged.

## 5. Key decisions → ADRs

- **ADR-054** — Bench fixture generation & caching: `git fast-import` +
  `~/.cache/tsgit-bench` version-keyed cache; large fixture opt-in
  (`TSGIT_BENCH_LARGE`), medium fixture in nightly CI via `actions/cache`.
- **ADR-055** — Per-OS mutation runs nightly, not per-PR (extends ADR-044).
- **ADR-056** — Benchmark-snapshot converter: median-ms metric,
  `customSmallerIsBetter`, stable `<scenario> > <bench>` naming.

Profiling output location (15.3) and the bench DSL shape (15.5) are
design-doc decisions — no architectural alternatives with lasting
consequences, so no ADR.

## 6. Risks & out of scope

- **Large-fixture generation time** — 50k commits / 200k blobs via
  `fast-import` is seconds-to-low-minutes; the 500 MB `repack` dominates.
  Mitigated by caching + opt-in gating.
- **`git` CLI dependency** — the generator needs `git` on `PATH`. Absent →
  scaled benches skip (never fail). The dev `clone-source` fixture already
  has this dependency.
- **gh-pages history growth** — `github-action-benchmark` appends to a data
  file on every `main` push. Acceptable; the action prunes via its own config
  if needed later.
- **Pre-existing, not addressed:** the `benchmark-compare` job's inline
  extractor keys results by bench name (`tsgit` / `isomorphic-git`) only, so
  multi-group runs collapse — every group's `tsgit` row overwrites the last.
  This predates Phase 15 and is out of scope; 15.6's `toSnapshotEntries`
  avoids it by keying on `<group> > <bench>`. Flagged for a future fix.
- **Out of scope:** wiring the large fixture into any always-on CI job;
  committing profiling captures; benchmarking against git CLI itself
  (isomorphic-git stays the sole baseline); fixing the `benchmark-compare`
  collapse above.
