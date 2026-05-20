# ADR-054: Bench fixture generation & caching

## Status

Accepted (at `5da3b52`)

## Context

Phase 15.1 / 15.2 call for a "medium" (5k commits / 20k blobs / ~50 MB) and a
"large" (50k commits / 200k blobs / ~500 MB) benchmark fixture. Three forces:

- **Generation speed.** `test/bench/fixtures.ts` `setupSmallRepo` builds repos
  via the tsgit API (`repo.add` + `repo.commit` per commit). At 50 commits
  that is fine; at 50 000 — each commit rewriting the index — it is far too
  slow to run on demand.
- **Storage.** A 500 MB fixture cannot live in git history. The committed
  `clone-source` fixture is 92 KB; four orders of magnitude larger is a
  non-starter, and Git LFS would add infrastructure the project does not
  otherwise need.
- **Representativeness.** `pack-read-scale.bench.ts` must exercise the pack
  reader. A repo of low-entropy blobs packs to almost nothing and measures
  nothing useful.

## Decision

A deterministic generator (`test/bench/support/fixture-generator.ts`) builds
the fixture once and **caches** it; benches reuse the cache.

- **`git fast-import`** ingests the commit stream — seconds, not minutes. The
  result is a normal git repo tsgit reads unchanged: the same trust boundary
  as the existing `git`-CLI-built `clone-source` fixture.
- The repo is **non-bare with working tree + index materialized**
  (`git init` → `fast-import` → `git checkout -f` → `git repack -ad`) so
  `status` benches have a real tree to scan and read benches hit a real pack.
- **Cache** under `${XDG_CACHE_HOME ?? ~/.cache}/tsgit-bench/<label>-v<version>/`
  with a `meta.json` sidecar (`{ version, headCommitId, firstBlobId, spec }`).
  A `FIXTURE_GENERATOR_VERSION` constant is the cache key — bumping it on any
  shape change invalidates stale caches. The cached directory is never deleted
  by benches.
- **Blob content** is deterministic pseudo-random (seeded xorshift PRNG keyed
  by blob index) so the pack is realistically sized yet reproducible.
- **Large fixture is opt-in** (`TSGIT_BENCH_LARGE=1`). The medium fixture runs
  in the nightly `bench.yml` with the cache restored via `actions/cache`; the
  large fixture is for local scale checks and manual `workflow_dispatch` only.
- If the `git` CLI is absent the generator throws and scaled benches `skipIf`
  — never a hard failure.

## Consequences

### Positive

- First run pays generation cost once; every later run is a cache hit.
- No large binaries in git history; no new infrastructure (LFS, artifact
  registry).
- The same generator serves medium and large — one code path, spec-switched.
- `repack -ad` + PRNG content make the pack-read benches genuinely
  representative of real-repo behaviour.

### Negative

- Adds a `git` CLI dependency for the scaled benches. Mitigated: absence
  skips, never fails; the dev `clone-source` fixture already needs `git`.
- First CI nightly run after a `FIXTURE_GENERATOR_VERSION` bump regenerates
  the medium fixture (cache miss) — a one-off slow night.

### Neutral

- The large fixture never runs in always-on CI by design; its regression
  signal comes only from manual / local runs.
- Pack bytes may differ across `git` versions. Benches measure read time, not
  byte-identity, so this does not affect results.

## Alternatives considered

- **Generate via the tsgit API** (extend `setupSmallRepo`) — rejected: 50 000
  sequential API commits is prohibitively slow for an on-demand generator.
- **Commit the fixtures** — rejected: 500 MB in git history.
- **Git LFS** — rejected: new infrastructure for a single use case.
- **Regenerate fresh every CI run** (no cache) — rejected: burns runner
  minutes on identical output every time.
