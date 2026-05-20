# Plan — Phase 15 bench + observability

Derived from `docs/design/phase-15-bench-observability.md` and ADRs 054-056.
Six backlog items, grouped into five implementation slices.

## Slice graph

```
A (15.5 bench DSL) ──▶ B (15.1/15.2 fixtures + scaled benches) ──▶ C (15.3 profiler)

D (15.4 per-OS mutation CI)   ── independent, parallelizable
E (15.6 snapshot converter)   ── independent, parallelizable
```

A → B → C is a chain: the scaled benches (B) use the DSL (A); the profiler (C)
uses the fixture generator (B). D and E touch only CI / `scripts/` and share no
files with the chain — they can land in any order. One branch, one atomic
commit per slice (finer where noted), one PR.

No slice adds `src/` code, so the 100%-coverage and mutation gates do not
expand. `npm run validate` must stay green after every commit.

## Slice A — Bench DSL wrapper (15.5)

**Files:** create `test/bench/support/bench-dsl.ts`; modify `log.bench.ts`,
`status.bench.ts`, `read-blob.bench.ts`, `clone-small-repo.bench.ts`.

1. **Implement** `benchScenario(given, whenThen, build, opts?)` — a thin
   wrapper over vitest `describe` + `bench()` calls. Two refinements over the
   design's first sketch, found while planning:
   - `build()` returns `{ sut, baseline? }`. `baseline` is **optional** —
     `bench('isomorphic-git', baseline)` is registered only when present.
     isomorphic-git's `statusMatrix` / `log` may not scale to a 20k-file or
     50k-commit fixture; a scaled scenario can then run tsgit-only.
     `bench-summarize.ts` already renders a missing entry gracefully.
   - `opts?: { skip?: boolean }` — when `skip` is true the wrapper uses
     `describe.skipIf(true)` with the same belt-and-suspenders early return as
     `clone-small-repo.bench.ts`. `clone-small-repo` and all three scaled
     benches need this gate.

   Bench **names** stay exactly `tsgit` / `isomorphic-git` (downstream keys on
   them); only the describe title gains the `Given … When … Then …` shape.
2. **Migrate** the four bench files to `benchScenario`, naming the tsgit
   closure `sut`. Preserve every existing `skipIf`, fixture, and `afterAll`.
3. **Verify** `npm run test:bench` still emits a `tsgit` + `isomorphic-git`
   row for every pre-existing scenario; `reports/benchmarks/raw.json` group
   count unchanged. No unit test — the wrapper is a vitest passthrough; the
   bench run is its contract.

_Commit:_ `test(bench): Given/When/Then DSL wrapper + migrate benches`.

## Slice B — Scaled fixtures + benches (15.1 / 15.2)

**Files:** create `test/bench/support/fixture-generator.ts`,
`scripts/gen-bench-fixture.ts`, `test/bench/log-scale.bench.ts`,
`test/bench/status-scale.bench.ts`, `test/bench/pack-read-scale.bench.ts`;
modify `package.json` (script `bench:fixture`), `.github/workflows/bench.yml`
(cache step).

1. **Implement `fixture-generator.ts`:** `FIXTURE_GENERATOR_VERSION`,
   `MEDIUM_FIXTURE` / `LARGE_FIXTURE` specs, `ensureScaledFixture(spec)`.
   - Cache dir `${XDG_CACHE_HOME ?? ~/.cache}/tsgit-bench/<label>-v<version>/`.
   - On cache miss: `git init` (non-bare) → stream a `git fast-import`
     commit/blob stream (seeded-xorshift PRNG content, fixed identity,
     monotonic timestamps) → `git checkout -f` → `git repack -ad` → capture
     `headCommitId` / `firstBlobId` → write `meta.json`.
   - `git` CLI absent → throw a typed `FixtureUnavailableError`.
2. **Implement `gen-bench-fixture.ts`:** CLI wrapper —
   `node … gen-bench-fixture.ts medium|large` calls `ensureScaledFixture`,
   prints the cached path. Wire `bench:fixture` into `package.json`.
3. **Implement the three `*-scale.bench.ts` files** with `benchScenario`
   (Slice A). Each: pick `process.env.TSGIT_BENCH_LARGE ? LARGE : MEDIUM`,
   `ensureScaledFixture`, `skipIf` on `FixtureUnavailableError` /
   Stryker / missing `git`. Never delete the cached dir.
4. **Modify `bench.yml`:** add an `actions/cache` step restoring
   `~/.cache/tsgit-bench` before `bench:summary`. The cache key uses
   `hashFiles('test/bench/support/fixture-generator.ts')` — a YAML workflow
   cannot read the `FIXTURE_GENERATOR_VERSION` TS constant, and hashing the
   generator file invalidates the cache on any shape change (the version bump
   included).
5. **Verify:** `npm run bench:fixture -- medium` builds + caches; a second run
   is a cache hit; `npm run test:bench` runs the scaled scenarios (or skips
   cleanly when `git` is absent); `TSGIT_BENCH_LARGE=1` selects the large spec.

_Commits:_ `test(bench): scaled fixture generator + CLI`; then
`test(bench): medium/large log/status/pack-read scenarios` (+ `ci:` for the
`bench.yml` cache step, foldable into the second).

## Slice C — Profiling driver (15.3)

**Files:** create `scripts/profile.ts`; modify `package.json` (script
`profile`), `.gitignore` (`reports/profiles/`).

1. **Implement `profile.ts`:** the script has two modes. Invoked plain, it is
   the **parent** — for each path in `['log','status','pack-read']` it spawns
   `node --prof profile.ts --child <path>`, then runs `node --prof-process` on
   the emitted `isolate-*.log`, writes `reports/profiles/<path>.txt`, and
   deletes the raw log. Invoked with `--child <path>`, it opens the cached
   medium fixture and loops that one operation. Self-spawning keeps it one
   file. Medium fixture unbuildable → clear message, exit non-zero.
2. **Modify** `.gitignore` to exclude `reports/profiles/`; wire `profile` into
   `package.json`.
3. **Verify:** `npm run profile` produces three non-empty digests; rerun is a
   fixture cache hit.

_Commit:_ `chore(profile): node --prof captures for log/status/pack-read`.

## Slice D — Per-OS mutation CI (15.4)

**Files:** create `.github/workflows/mutation-os.yml`.

1. **Implement** the workflow: `schedule` cron (offset from `bench.yml`'s
   `14 3 * * *`) + `workflow_dispatch`; `strategy.matrix.os:
   [macos-latest, windows-latest]`; `./.github/actions/setup`; `npm run
   test:mutation`; `timeout-minutes: 90`; `actions/upload-artifact` of
   `reports/mutation/` named per OS.
2. **Verify:** `actionlint` / MegaLinter clean; a `workflow_dispatch` smoke
   run is left for post-push (a full per-OS mutation run is inherently a
   nightly/manual concern).

_Commit:_ `ci: nightly per-OS mutation on macOS + Windows`.

## Slice E — Benchmark-snapshot converter + CI re-enable (15.6)

**Files:** create `scripts/bench-to-snapshot.ts`,
`test/unit/scripts/bench-to-snapshot.test.ts`,
`test/unit/scripts/fixtures/raw-bench.json`; modify `.github/workflows/ci.yml`
(replace the disabled `benchmark-snapshot` comment block with a real job).

1. **Red:** write `bench-to-snapshot.test.ts` against `toSnapshotEntries` —
   empty `files`, single group (median present), mean-fallback (median
   absent), multi-group flattening, name = `"<group> > <bench>"`, unit `ms`.
   A small committed `raw-bench.json` fixture backs the multi-group case.
2. **Green:** implement `bench-to-snapshot.ts` — its own minimal `RawReport`
   interface, pure `toSnapshotEntries`, and a `main()` guarded by
   `import.meta.url === pathToFileURL(process.argv[1]).href` (so the test
   import does not execute it). `main()` reads `reports/benchmarks/raw.json`
   and writes `reports/benchmarks/snapshot.json` — the file the CI job hands
   to the action's `output-file-path`.
3. **Refactor:** keep `toSnapshotEntries` small and pure; `main()` only does
   read-file → convert → write-file.
4. **Modify `ci.yml`:** replace the Stage-7 disabled block with a
   `benchmark-snapshot` job — on push to `main`: `npm run test:bench` →
   `node … bench-to-snapshot.ts` → `benchmark-action/github-action-benchmark@v1`
   (`tool: customSmallerIsBetter`, `auto-push: true`, alert threshold,
   `comment-on-alert`); job-local `permissions: contents: write`.
5. **Verify:** `npm run test:unit` covers the converter; `npm run validate`
   green. Confirm the new job coexists with `gh-pages.yml` — the action
   appends under its own `benchmark-data-dir-path`, but if `gh-pages.yml`
   does a clean/orphan deploy that would wipe the benchmark data, that
   collision must be resolved (point the action at a dedicated dir, or
   reconcile the two publishers).

_Commit:_ `feat(ci): benchmark-snapshot converter + re-enabled gh-pages job`.

## Cross-cutting verification (workflow steps 6-8)

- After each slice: `npm run validate` green.
- New niche words (`xorshift`, `repack`, `fanout`, …) → add to the cspell
  dictionary if `check:spelling` flags them.
- Wire every new `scripts/` file into a `package.json` script so `check:dead-code`
  (knip) sees an entry point; bench/support files are reached via bench imports.
- Keep the three `*-scale.bench.ts` files DRY (shared setup via the generator
  + DSL) so `check:duplicates` does not flag them.
- Three review passes on the full diff (code / perf / security / tests).
- `stryker run` — no `src/` change, so the mutation surface is unchanged;
  confirm no regression.
- **Docs (step 8):** `RUNBOOK.md` — document `bench:fixture`, `profile`,
  `TSGIT_BENCH_LARGE`, the scaled benches, and nightly per-OS mutation;
  `CONTRIBUTING.md` — note the bench DSL convention; `README.md` — only if it
  advertises a perf/bench surface. Flip `docs/BACKLOG.md` 15.1-15.6 to `[x]`
  and 11.2 `[~]` → `[x]` inside this PR's commits.

## Dependencies & ordering

1. Slice A (no deps).
2. Slice B (needs A).
3. Slice C (needs B).
4. Slices D, E — any time, parallel to the chain.
5. Reviews → harness → docs → PR.
