# Design — Benchmark regression gate in CI

> Brief (backlog 26.5): "Regression gate in CI — `bench:summary` diff must not
> exceed ±N% per scenario." It closes the Phase-26 performance pass, **locking
> the final numbers**: it runs after every optimisation (26.4/26.4a/26.4b/26.4c/
> 26.7a) has landed and its job is to stop a future change from silently
> regressing the now-optimised perf surface. This is a **CI/tooling** feature —
> it adds no library or command surface.
> Status: draft → self-reviewed ×3 → decision candidates pending ADR conversation
> (ADRs 487+).

This design confronts one central tension head-on: **the backlog asks for a
blocking per-scenario ±N% gate, but the entire existing perf apparatus is
deliberately non-blocking because CI bench noise is ~±20%** (ADR-483; the
`benchmark-compare` job is `continue-on-error`; `benchmark-snapshot` runs
`fail-on-alert:false`). A naive blocking gate with N < 20% flakes on every PR;
with N > 20% it catches only gross regressions. ADR-483 further warns that
comparing across environments — a baseline captured on runner A versus a PR
measured on runner B — is exactly the uncitable/noisy case. Every load-bearing
choice that resolves this tension is deferred to the user as a decision candidate;
the recommendations below are the designer's reasoned defaults, not decisions.

## Context

The bench pipeline already exists end-to-end; this feature adds a **comparison
step** on top of it, plus a **committed baseline** to compare against. The
surface, verified against the live tree in this worktree:

- **`npm run test:bench`** (wireit) → `vitest bench --run --config
  vitest.bench.config.ts` over `test/bench/**/*.bench.ts` → writes
  `reports/benchmarks/raw.json`. Depends on `check:types`. Cached on
  `src/**/*.ts` + `test/bench/**/*.ts` + the config.
- **`npm run bench:summary`** (wireit, dep `test:bench`) → `tooling/bench-summarize.ts`
  → `reports/benchmarks/summary.md`, a **human markdown table** (`Scenario | tsgit
  | isomorphic-git | speedup`). This is the artifact the backlog names, but it is
  **not machine-diffable** — the diffable artifact is `raw.json` (or the derived
  `snapshot.json`).
- **`tooling/bench-to-snapshot.ts`** → `reports/benchmarks/snapshot.json` in
  github-action-benchmark's `customSmallerIsBetter` schema. Exports
  `toSnapshotEntries(raw: RawReport): SnapshotEntry[]`, flattening **every**
  `(group, bench)` pair generically into `{ name: '<group.fullName> > <bench.name>',
  unit: 'ms', value: median ?? mean }`. No competitor allow-list. **This is the
  machine-diffable, per-scenario, median-ms artifact the gate should build on.**
- **Bench scenario files** (`test/bench/*.bench.ts`): `blame-deep-ancestry`,
  `clone-small-repo`, `delta-chain-read`, `describe`, `log`, `log-scale`,
  `name-rev`, `pack-read-scale`, `status`, `status-scale` (+ `fixtures.ts`,
  `support/`). Each scenario is a vitest `describe` group; inside, `benchScenario`
  (`test/bench/support/bench-dsl.ts`) emits a `bench()` literally named **`tsgit`**
  and, for competitor scenarios, one named **`isomorphic-git`**. tsgit-only
  scenarios (`blame-deep-ancestry`, `describe`, `name-rev`) emit only `tsgit`.
- **`vitest.bench.config.ts`**: `outputJson: 'reports/benchmarks/raw.json'`,
  `testTimeout: 120_000`.

**Empirically-pinned `raw.json` schema** (throwaway vitest bench run in this
worktree's `.probe-tmp/`, removed after — nothing committed):

```
{ files: [ { filepath, groups: [ { fullName, benchmarks: [ { name, hz, mean,
  median, min, max, rme, p75, p99, samples, ... } ] } ] } ] }
```

Load-bearing facts pinned by that run:

- `group.fullName` is **`<relative-bench-file-path> > <full describe title>`**
  (e.g. `test/bench/status.bench.ts > Given a clean 50-commit working tree, When
  status() scans it, Then compare tsgit against isomorphic-git`) — **not** the
  short scenario name. `bench-summarize.ts` derives a short scenario name by
  splitting on ` > ` and taking the last segment; `bench-to-snapshot.ts` keeps the
  full `fullName`. The gate's per-scenario key must pick one and pin it (see
  §Design → key format).
- `bench.name` is exactly `tsgit` / `isomorphic-git`.
- `median`, `mean`, `min`, `hz`, `rme` are all present. `bench-to-snapshot.ts`
  uses `median ?? mean` (median-ms, smaller-better).

**gitignore reality** (`.gitignore` lines 14–19): `reports/*` is gitignored
**except** `!reports/api.json`. So `raw.json` / `snapshot.json` / `summary.md` are
ephemeral and **not committed**. A committed baseline therefore needs either a new
gitignore exception (e.g. `!reports/benchmarks/baseline.json`) or a home **outside**
`reports/` (e.g. `test/bench/baseline.json`). Candidate #4 decides.

**Existing CI perf jobs** (`.github/workflows/ci.yml`, Stage 7):

- **`benchmark-snapshot`** (push to main only): `test:bench` → `bench-to-snapshot.ts`
  → `benchmark-action/github-action-benchmark@v1`, `tool: customSmallerIsBetter`,
  `auto-push:true`, `gh-pages-branch: gh-pages`, `benchmark-data-dir-path: dev/bench`,
  `alert-threshold:'150%'`, `fail-on-alert:false`. **Trend tracking only.** The
  `gh-pages` branch is a dedicated benchmark-data store — **must not be
  repurposed/deleted** (deleting it breaks every main CI run at the snapshot step).
- **`benchmark-compare`** (PR, `continue-on-error:true`): checks out the base sha,
  builds+benches it, then builds+benches the PR branch **on the same runner**,
  compares **ops/s** (`hz`) per `<group.fullName> > <bench.name>` key, threshold
  **5%**, posts a PR comment. **Explicitly informative-only, never blocks** — its
  own inline comment reads: *"same-runner benchmarking measures too much noise to
  block on."* Its inline node script `extractBenchmarks` already keys on
  `${group.fullName} > ${b.name}` and reads `hz`/`mean`/`p99`.
- **`.github/workflows/bench.yml`** — the **nightly** benchmark (cron `14 3 * * *`
  UTC + `workflow_dispatch`), dedicated runner, no contention. Pre-warms fixtures,
  runs `bench:summary` + `bench:memory`, uploads `reports/benchmarks/` as a 30-day
  artifact. **This is ADR-483's clean reference environment.**

**Governing prior art (read in full, not summarised from memory):**

- **ADR-483** (committed hand-transcribed benchmark snapshot): benchmarks are
  noisy (repo warns ±20% on GHA runners); a **personal host is not a reliable
  reference** (interactive-load bias — iso-git measured 1.2–2.4× slower under
  load); the **CI nightly (`bench.yml`) is the clean reference**; published numbers
  are hand-transcribed committed snapshots with provenance. Crucially it states a
  *"`bench:publish` formalisation remains available as a later hardening **adjacent
  to the 26.5 regression gate**"* — **this feature is the anticipated home** for
  formalizing a committed baseline.
- **ADR-486** (status:clean validation + baseline policy): a **same-host
  before/after ratio is load-independent** (both sides pay the same contention) —
  the method that proved "no regression" in the 26.7a investigation. A committed
  whole-command profile baseline exists (`docs/perf/baseline.json`) but there is
  **no baseline-drift CI gate today** — the baseline is a documentation artifact.
  Explicitly notes the per-scenario `bench:summary` diff gate is "out of scope
  here … until the 26.5 regression gate formalises" it.
- **`docs/design/competitor-benchmarks.md`** (house-style template + the
  `bench-summarize` / `bench-to-snapshot` surface map): the six published
  small-repo comparison scenarios are `log`, `readBlob:cold`, `readBlob:warm`,
  `status:clean`, `status:dirty`, `clone`. Bench files and `tooling/**` are
  **excluded from coverage** (`vitest.config.ts` coverage `include` =
  `src/{domain,ports,adapters/node,adapters/memory,operators}/**` only).
- **`docs/design/status-clean-perf-investigation.md`**: same-host before/after
  ratios are the load-bearing evidence; absolute local numbers are not citable;
  the CI nightly is the citable source. Used `tsgit min` as the least-noise
  estimator for a same-host ratio.

## Constraints

1. **±20% CI-runner noise is the governing physical reality** (ADR-483). Any gate
   whose threshold approaches or falls below the per-scenario noise floor will
   flake. This is the single hardest constraint and it shapes candidates #1, #2,
   #3.
2. **Cross-environment comparison is the uncitable case** (ADR-483). A baseline
   captured on the nightly runner (linux-x64 / AMD EPYC 7763) versus a PR measured
   on an arbitrary `ubuntu-latest` PR-runner is an apples-to-oranges comparison the
   ADR explicitly warns against. A **same-runner** base-vs-PR ratio (candidate
   #1(b)) sidesteps this; a **committed-baseline** approach (candidate #1(a)) must
   absorb the cross-env variance into a wide threshold.
3. **gitignore** — a committed baseline needs an explicit home (new
   `!reports/benchmarks/…` exception, or under `test/bench/`). `reports/*` is
   otherwise fully ignored (candidate #4).
4. **`gh-pages` is load-bearing infrastructure** — the `benchmark-snapshot` trend
   store. Do not delete/repurpose it. Flipping its `fail-on-alert` (candidate
   #1(c)) is an option but is a *post-merge* gate, not a PR gate.
5. **Faithfulness (ADR-226) is N/A here.** A benchmark **measures wall-clock
   time**; it asserts no git-observable behaviour, so this change pins **no
   faithfulness matrix** and adds **no interop test** (same reasoning as
   `competitor-benchmarks.md`). The only empirical matrix pinned is the `raw.json`
   **schema** above — a data-shape pin for the comparison tool, not a behaviour
   pin. Every fixture `git` invocation stays env-isolated exactly as today; this
   change adds no new `git`-spawning surface.
6. **ADR-249 (structured output, no cosmetics) is N/A to the library.** All
   comparison/threshold logic lives in `tooling/**` + `.github/workflows/**`; no
   `openRepository`/command option gains a gate/formatting job. The gate consumes
   the already-structured `raw.json` fields (`median`/`hz`), it does not add a
   rendering surface to any command.
7. **No coverage/mutation obligation on the tooling.** `tooling/**` and
   `test/bench/**` are excluded from `vitest.config.ts` coverage `include`
   (precedent: `tooling/profile.ts`, `tooling/bench-memory.ts`,
   `bench-summarize.ts`). The comparison tool's **pure helpers** are nonetheless a
   good candidate for an optional `tooling/test/unit` test (a `tooling/test/unit`
   dir already exists) — welcome, not gated (see §Test strategy).

## Design

### The core reframe — `snapshot.json`, not `summary.md`, is the diff surface

The backlog says "`bench:summary` diff." Taken literally that means diffing
`summary.md`, a rendered human table with embedded `hz`/`rme` prose and a
timestamp line — brittle and semantically opaque. The **machine-diffable** artifact
is `snapshot.json` (per-scenario, per-bench, median-ms, already produced by
`tooling/bench-to-snapshot.ts` and consumed by the trend job). **The gate compares
`snapshot.json`-shaped entries, not `summary.md` text.** `summary.md` remains the
human-facing render; the gate keys on the structured data underneath it. This is
the ADR-249 discipline applied to the gate itself: compare data, not the render.

### Comparison algorithm (concrete, regardless of which candidate lands)

Given a **baseline** set of entries and a **current** set of entries (both the
`{ name, unit:'ms', value }` shape `toSnapshotEntries` already emits):

1. **Parse `raw.json` → current entries** via the existing `toSnapshotEntries(raw)`
   — reuse it, do not re-implement the flattening.
2. **Filter to the gated bench set.** Keep only entries whose `bench.name` is
   `tsgit` (candidate #5(a) recommendation) — i.e. drop the `isomorphic-git`
   entries the project does not control. Concretely: an entry's key ends in
   ` > tsgit`. (Candidate #5 may widen this.)
3. **Join current ⋈ baseline on the per-scenario key.** The key is the full
   `snapshot.json` `name` (`<group.fullName> > tsgit`) — stable, already the
   snapshot format, and unambiguous across scenarios.
4. **Per matched scenario, compute the regression delta.** With median-ms
   (smaller-better): `delta% = (current.value − baseline.value) / baseline.value ×
   100`. A **positive** delta is a regression (slower). Apply the threshold policy
   (candidate #3): fail the scenario iff `delta% > N` (asymmetric — improvements
   never fail).
5. **Handle set mismatches** (candidate #5): a scenario **in baseline but missing
   from current** (a scenario was renamed/removed) → decide fail-or-warn; a scenario
   **in current but missing from baseline** (a *new* scenario) → **pass** with a
   note ("not yet in the baseline"), never fail — so adding a bench never breaks
   the gate.
6. **Aggregate → exit code.** Non-zero iff any gated scenario regressed beyond N.
   Emit a per-scenario table (scenario | baseline ms | current ms | delta% |
   verdict) to stdout + `$GITHUB_STEP_SUMMARY`.

The whole algorithm is a **pure function** over `(baselineEntries, currentEntries,
policy)` returning `{ rows, failed }`; I/O (read `raw.json`, read baseline, write
summary, set exit code) wraps it. That pure core is the unit-testable SUT
(§Test strategy).

### Key format — pin it once

`bench-to-snapshot.ts` keys on `<group.fullName> > <bench.name>`;
`bench-summarize.ts` shortens to the last ` > ` segment; `benchmark-compare` keys
on `<group.fullName> > <bench.name>`. **The gate reuses `toSnapshotEntries`'s key
verbatim** (`<group.fullName> > tsgit`) so the baseline file, the gate, and the
existing snapshot/trend surface all speak one key format. No new key scheme is
introduced. Consequence: the baseline file is literally a filtered
`snapshot.json` (only ` > tsgit` entries) — the same schema, the same generator.

### Where the comparison logic lives (candidate #6)

Recommendation: a **new `tooling/bench-check.ts`** (analogous to
`bench-to-snapshot.ts`), exporting a pure `compareToBaseline(baseline, current,
policy)` and a thin `main()` that reads `raw.json` + the committed baseline, runs
the comparison, prints the table, and `process.exit(1)` on regression. It
**imports and reuses `toSnapshotEntries`** from `bench-to-snapshot.ts` for the
current-side flatten (no duplication). A `npm run bench:check` wireit script
(dep `test:bench`, files `tooling/bench-check.ts` + the baseline + `raw.json`)
wires it in. This keeps `bench-to-snapshot.ts` untouched (generic) and the new
threshold logic isolated and independently testable.

### Baseline capture & refresh (candidate #2 + #4)

The baseline is a **committed, provenance-carrying** filtered `snapshot.json`
(`tsgit`-only entries), sourced — per ADR-483 — from a **dated CI nightly
(`bench.yml`) artifact**, not a personal host. Its home and refresh procedure are
candidate #4; the documented refresh flow is: download the latest nightly
`benchmarks` artifact → run `bench-to-snapshot.ts` on its `raw.json` (or read the
committed snapshot the nightly could emit) → filter to `tsgit` → write the baseline
file with an updated provenance line (runner OS/arch, CPU, Node, capture date) →
commit **in the same PR** that legitimately changes perf. A perf-improving or
perf-justified-regressing PR updates the baseline as part of the change (exactly
how ADR-486 handles the profile baseline); the gate then passes against the new
baseline. **The baseline is never auto-regenerated by the gate itself** (that would
make the gate a no-op) — it is a deliberate human commit.

### CI wiring (candidate #1 + #2 decide the shape)

Three mutually-exclusive shapes, one per candidate-#1 option:

- **#1(a) committed-baseline gate** — a new `benchmark-gate` PR job:
  `test:bench` (fresh PR-runner bench) → `bench-check.ts` against the committed
  baseline → non-zero exit fails the job. Blocking iff candidate #2 says hard-gate;
  `continue-on-error:true` if soft. Cross-env, so needs a **wide** N (candidate #3).
- **#1(b) same-runner base-vs-PR, promoted** — reuse the existing
  `benchmark-compare` runner recipe (base bench + PR bench on one runner), swap its
  informative comment for a **non-zero exit** on regression beyond N, drop
  `continue-on-error` (or keep it for a soft gate). No committed baseline needed;
  the base branch **is** the baseline. Same-runner ratio sidesteps the cross-env
  warning (constraint #2) → **tighter N is defensible**.
- **#1(c) post-merge trend gate** — flip `benchmark-snapshot`'s
  `fail-on-alert:true` and tighten `alert-threshold`. Gates **after** merge on the
  `gh-pages` trend series, not on the PR. Cheapest, but catches regressions only
  after they land on main.

### Pre-chewed context blocks (every file the plan will touch)

**Part A — `tooling/bench-check.ts` (new).**
- Import `toSnapshotEntries` + `RawReport` from `./bench-to-snapshot.ts` (both
  already `export`ed — verified). **`SnapshotEntry` is declared but NOT exported**
  in `bench-to-snapshot.ts`; the implementer must either add `export` to that
  interface (one-word diff, generic converter unaffected) or re-declare the
  `{ name; unit:'ms'; value:number }` shape locally in `bench-check.ts`. Prefer the
  `export` — single-source the type.
- Export a pure `compareToBaseline(baseline: readonly SnapshotEntry[], current:
  readonly SnapshotEntry[], policy: { thresholdPct: number }): { rows: ReadonlyArray<{
  key; baselineMs; currentMs; deltaPct; verdict: 'pass'|'regress'|'new'|'missing' }>;
  failed: boolean }`. Pure, deterministic, no I/O — the unit SUT.
- Filter helper `gatedEntries(entries)` → keep keys ending ` > tsgit`.
- `main()`: read `reports/benchmarks/raw.json`, `toSnapshotEntries` → filter →
  read the committed baseline JSON → `compareToBaseline` → print table to stdout +
  append to `$GITHUB_STEP_SUMMARY` → `process.exit(failed ? 1 : 0)`. Follow the
  `invokedDirectly()` guard idiom from `bench-to-snapshot.ts`.
- Mirror `bench-to-snapshot.ts`'s error handling: `main().catch` → stderr +
  `process.exit(1)`. **No swallowed errors** (contract).

**Part B — the committed baseline file (candidate #4 picks the path).**
- Shape: a `snapshot.json`-schema JSON array of `{ name, unit:'ms', value }`,
  `tsgit`-only, plus a provenance sidecar (either a `_meta` field or a companion
  `.md` — candidate #4 decides). Path options: `test/bench/baseline.json` (no
  gitignore change) **or** `reports/benchmarks/baseline.json` + a
  `!reports/benchmarks/baseline.json` gitignore exception.
- First capture: from a dated `bench.yml` nightly artifact (§Rollout).

**Part C — `package.json` scripts + wireit.**
- Add `bench:check` wireit script: `command: node --experimental-strip-types
  tooling/bench-check.ts`, `dependencies: ['test:bench']`, `files:
  ['tooling/bench-check.ts', '<baseline path>', 'reports/benchmarks/raw.json']`,
  no `output` (it is a gate, not a producer). Node's `--experimental-strip-types`
  is the established tooling invocation (see `bench-to-snapshot.ts` in
  `benchmark-snapshot`); note the tooling-import gotcha — `bench-check.ts` imports
  only from another `tooling/*.ts` (`bench-to-snapshot.ts`), **not** from `src/`,
  so strip-only Node is fine (no parameter-property/`.js`-specifier issue).

**Part D — `.github/workflows/ci.yml` (shape per candidate #1).**
- #1(a): new `benchmark-gate` job (PR-triggered, `needs: [changes, unit-tests]`,
  the fixture-cache restore step like `benchmark-snapshot`) → `test:bench` →
  `node --experimental-strip-types tooling/bench-check.ts`. `continue-on-error`
  per candidate #2.
- #1(b): edit `benchmark-compare` — replace the "informative only, never exit
  non-zero" tail with a threshold exit; reconsider `continue-on-error`.
- #1(c): edit `benchmark-snapshot` — `fail-on-alert:true`, tighten
  `alert-threshold`.
- `bench.yml` (nightly) is unchanged in all three — it remains the clean baseline
  source (Rollout).

**Part E — `tooling/test/unit/bench-check.test.ts` (recommended; runs but
un-gated).**
- Unit-test the pure `compareToBaseline` with synthetic fixture entries
  (deterministic, no bench run). `tooling/test/unit/**` **is** in the `test:unit`
  vitest `include`, so this executes alongside the rest; it is excluded only from
  the coverage `include`, so it carries no coverage/mutation gate. Mirror
  `tooling/test/unit/bench-to-snapshot.test.ts`. See §Test strategy.

**Part F — docs.**
- `docs/understand/performance.md` (or a release-checklist doc) gains the baseline
  **refresh procedure** (download nightly artifact → regenerate → re-provenance →
  commit in the perf PR), mirroring ADR-486's profile-baseline refresh note.

### Error semantics / edge behaviour

- **New scenario (in current, not in baseline)** → verdict `new`, **passes**, with
  a stdout note. Adding a bench never breaks the gate; the baseline is topped up on
  the next legitimate refresh.
- **Removed/renamed scenario (in baseline, not in current)** → verdict `missing`.
  Recommendation: **warn, do not fail** (a rename is a legitimate refactor; failing
  here would block harmless renames) — but this is a candidate-#5 sub-decision.
- **`git`/`git-http-backend` absent or Stryker sandbox** → the underlying bench
  scenario already `SKIP`s (e.g. `clone-small-repo.bench.ts`); a skipped scenario
  simply does not appear in `raw.json` → treated as `missing`/absent, never a
  fabricated regression. The gate must not fail on a scenario the runner could not
  measure.
- **Baseline file absent/empty** → hard error in `main()` (the gate cannot run
  without a baseline), non-zero exit with a clear message. Not silently passed.
- **Zero baseline value** (division guard) → treat as an error/skip for that
  scenario, never `Infinity`% — mirror `formatSpeedup`'s `b === 0 → 'n/a'` guard.
- **iso-git entries** → filtered out before comparison (candidate #5(a)); they
  never contribute to a verdict. If candidate #5 widens scope, they are gated with
  a wider N (we do not control iso-git's code).

## Decision candidates

Every candidate is a **load-bearing choice not pre-decided by an existing ADR**;
the designer does not decide these — the user does, in the ADR conversation. ≤3
alternatives each, with a recommendation. (Next ADR numbers land at **487+**;
highest existing is 486. No ADR/phase/backlog number appears in any source/config/
test — only here and in the PR body.)

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **Comparison model / noise strategy** | (a) **Committed baseline** (from a nightly artifact per ADR-483) vs fresh PR-runner bench, **wide** per-scenario threshold. (b) **Same-runner base-vs-PR**, promoting the existing `benchmark-compare` recipe to a gate with a robust threshold (optionally best-of-K). (c) **Flip `benchmark-snapshot` `fail-on-alert:true`** — a *post-merge* trend gate on `gh-pages`. | **(b)** | ADR-483's sharpest warning is against **cross-environment** comparison; (a) is exactly that (nightly runner A vs PR runner B) and must swallow the cross-env variance into a threshold so wide it barely gates. (b)'s **same-runner base-vs-PR ratio is load-independent** — both sides pay the same contention (the exact method ADR-486 / 26.7a used to prove "no regression"), so a *tighter, defensible* N is possible and it needs **no committed baseline to drift**. (c) only catches regressions **after** they land on main. (b) also reuses infra that already exists. If the user prefers a citable committed baseline, (a) is the ADR-483-anticipated shape — pick it with a wide N (candidate #3) and accept it gates only gross regressions. |
| 2 | **Blocking vs advisory posture** | (a) **Hard gate** — non-zero exit blocks merge. (b) **Soft gate** — runs, prints the table, but `continue-on-error:true` (fails visibly, never blocks) — tighter/committed version of today. (c) **Hard gate scoped to gross regressions only** — blocks only when a scenario exceeds a large N (e.g. >50%), advisory below that. | **(c)** | A truly hard gate at a tight N contradicts the established `continue-on-error` posture and the ±20% noise reality — it *will* flake and erode trust. Pure advisory (b) is honest but adds little over today's `benchmark-compare`. (c) threads the backlog's "must not exceed" language against the physics: **block only what noise cannot explain** (a gross, unambiguous regression), stay advisory in the noisy band. This is the honest reading of "regression gate" given ±20% noise. |
| 3 | **Threshold N + metric** | (a) **One global N**, median-ms (matches `snapshot.json`, smaller-better), **asymmetric** (regressions blocked, improvements free). (b) **Per-scenario N**, median-ms — syscall-heavy scenarios (`status`, cold `readBlob`) get a wider band than CPU-bound ones. (c) **ops/s (`hz`)** metric (matches `benchmark-compare`), single N. | **(a)** with **N tuned to the model**: for same-runner #1(b), **N ≈ 10–15%** (ratio is load-independent, so tighter than raw noise); for committed-baseline #1(a), **N ≈ 25–30%** (must absorb cross-env variance above the ±20% floor). | Median-ms is the least-noise central estimator and already the `snapshot.json` unit — reusing it keeps one metric across gate + trend + snapshot. **Asymmetric** is essential: an *improvement* must never fail the gate. One global N (a) is simplest and defensible; per-scenario N (b) is more precise but higher-maintenance and invites bikeshedding — defer unless a specific scenario proves chronically noisy. ops/s (c) only to match `benchmark-compare` if #1(b) reuses it verbatim; median-ms is otherwise cleaner. **N must be justified against measured noise, not guessed** — the ADR conversation should cite the nightly artifact's per-scenario `rme`. |
| 4 | **Baseline artifact: home, format, refresh** | (a) **`test/bench/baseline.json`** — no gitignore change; lives with the benches it describes. (b) **`reports/benchmarks/baseline.json`** + a `!reports/benchmarks/baseline.json` gitignore exception — co-located with the ephemeral snapshot it mirrors. (c) **No committed baseline** (only viable if candidate #1 is (b) same-runner or (c) trend). | **(a)** if a baseline is committed (candidate #1(a)); **(c)** if candidate #1 is (b). | (a) keeps the baseline beside `test/bench/**` (the benches that define it), needs **no** `.gitignore` surgery, and reads naturally as test fixture data. (b) mirrors the `reports/api.json` precedent (a committed exception under an ignored dir) but adds gitignore complexity for no functional gain. **Format**: a filtered `snapshot.json` (`tsgit`-only, `{name,unit,value}[]`) + a provenance line (nightly runner OS/arch, CPU, Node, capture date) — reuse the existing schema, don't invent one. **Refresh**: documented manual step in the perf PR, sourced from a **dated nightly artifact** (ADR-483), never a personal host, never auto-regenerated by the gate. **Note:** candidate #4 is moot under #1(b)/(c) (no committed baseline) — the base branch or the trend series is the baseline. |
| 5 | **Scenario scope** | (a) **Gate only `tsgit`-named benches** — exclude the `isomorphic-git` competitor entries we don't control. (b) **Gate all benches** including iso-git. (c) **Gate an explicit allow-list** of the stable-surface scenarios only. | **(a)** | The gate protects **tsgit's** perf; iso-git is a pinned dependency whose code cannot change and whose timing shifts are pure noise from our side — gating it adds flake with zero signal. (a) keys on the ` > tsgit` suffix (already the bench name). (c) is more conservative but needs a hand-maintained list that drifts as scenarios are added. **New-scenario handling** (both (a) and (c)): a scenario present in `raw.json` but absent from the baseline **passes** as `new` — onboarding a bench never breaks the gate; it enters the baseline at the next legitimate refresh. |
| 6 | **Tooling shape** | (a) **New `tooling/bench-check.ts`** exporting a pure `compareToBaseline`, reusing `toSnapshotEntries`; new `bench:check` wireit script. (b) **Extend `bench-to-snapshot.ts`** with a compare mode (flag-driven). (c) **Inline node script in the CI YAML** (like `benchmark-compare` today). | **(a)** | (a) is the SRP-clean shape: `bench-to-snapshot.ts` stays a pure converter (generic, untouched), the threshold logic is isolated, and the pure `compareToBaseline` is independently unit-testable (§Test strategy) — matching the project's small-focused-tooling style. (b) overloads one file with two responsibilities (convert **and** judge). (c) buries logic in YAML where it cannot be unit-tested (the current `benchmark-compare` pain). Reusing `toSnapshotEntries` keeps the flatten logic single-sourced. |

## Test strategy

- **No coverage/mutation obligation.** `tooling/**` and `test/bench/**` are
  excluded from `vitest.config.ts` coverage `include`
  (`src/{domain,ports,adapters/node,adapters/memory,operators}/**` only) — same
  precedent as `tooling/profile.ts` / `tooling/bench-memory.ts` /
  `bench-summarize.ts`. So `bench-check.ts` carries **no** coverage or mutation
  gate. This is stated so review does not raise a false-positive coverage flag.
- **Recommended unit test** for the pure `compareToBaseline` core in
  `tooling/test/unit/bench-check.test.ts`. **Strong sibling precedent:**
  `tooling/test/unit/bench-to-snapshot.test.ts` already unit-tests
  `toSnapshotEntries` with synthetic `RawReport` fixtures, and
  `tooling/test/unit/**/*.test.ts` **is** in the `test:unit` vitest project's
  `include` (verified) — so the test **runs** (it is coverage-excluded, not
  execution-excluded). Mirror that file's fixture shape. **One caveat:** that
  sibling names the *result* `sut` (`const sut = toSnapshotEntries(...)`), which
  contradicts CLAUDE.md (`sut` = the function/object under test; result → `result`)
  — do **not** copy that mistake; name the SUT `compareToBaseline` and the returned
  verdict `result`. `compareToBaseline` is a **pure, deterministic,
  easily-isolated function** — exactly the kind worth testing even though nothing
  gates it. Feed synthetic `SnapshotEntry[]` fixtures (no bench run):
  - Given a current entry N% slower than baseline **above** the threshold → verdict
    `regress`, `failed: true`.
  - Given a current entry N% slower **below** threshold → verdict `pass`,
    `failed: false`.
  - Given a current entry **faster** than baseline (negative delta) → `pass`
    (asymmetry proven — this test kills the "improvement fails" mutant).
  - Given a scenario in current but **not** baseline → verdict `new`, does not fail.
  - Given a scenario in baseline but **not** current → verdict `missing`, warns per
    candidate #5.
  - Given a **zero baseline value** → guarded (`n/a`/skip), never `Infinity`.
  - **Boundary isolation** (CLAUDE.md mutation-resistance): test **exactly at** the
    threshold and **one step either side** as separate tests — a single test
    straddling the boundary does not prove the `>` vs `>=` comparator. Assert the
    **numeric `deltaPct`** and the **verdict enum**, not just `failed` — a
    verdict-only assertion lets StringLiteral/comparator mutants survive.
  - Follow test conventions: `describe('Given …')` > `describe('When …')` >
    `it('Then …')`, AAA body, SUT named `sut` (the `compareToBaseline` function),
    result in `result`.
- **Property-test lenses (CLAUDE.md) — do they fit?** `compareToBaseline` is a
  **compositional aggregator** (reduces a set of per-scenario deltas to a verdict —
  lens 2). A property is defensible: *empty gated set → `failed: false` (identity)*;
  *appending one regressing scenario flips `failed` to true*; *appending only
  improving scenarios never flips it*. If the plan adopts the unit test, a
  `bench-check.properties.test.ts` sibling (numRuns 100, invariant tier) is a
  reasonable add — but **ungated**, and only if the diff logic is non-trivial
  enough to warrant it. It is **not** a round-trip pair, so lens 1 does not apply.
- **No faithfulness matrix / no interop test.** The change asserts no
  git-observable behaviour (it measures wall-clock time and thresholds it), so per
  ADR-226 there is nothing to pin cross-tool. The only empirical matrix pinned is
  the `raw.json` **schema** (§Context) — a data-shape pin for the parser, recorded
  here, not in `test/integration/*-interop.test.ts`.
- **The gate itself is exercised by CI**, not by unit tests: the `bench:check` run
  in the PR/nightly job is the integration proof. A green baseline run (current ≈
  baseline within N) proves the happy path; a deliberately-lowered N in a scratch
  run proves the fail path during development (not committed).
- **Manual verification during rollout:** run `bench:check` against the freshly
  captured baseline on the same machine → expect all `pass` (deltas near 0);
  temporarily halve N → expect the noisiest scenario to flip `regress` (proves the
  gate fires). Neither is committed.

## Rollout

Steps 1 and 3 apply **only to the committed-baseline path** (candidate #1(a)).
Under same-runner (#1(b)) there is no baseline to capture — the base branch is the
baseline — so only step 2 (soft-first calibration) applies; under the trend gate
(#1(c)) only the threshold-tuning half of step 2 applies.

1. **Capture the first baseline from a dated nightly** *(committed-baseline path
   only)***.** Trigger `bench.yml`
   (`workflow_dispatch`) or take its latest scheduled artifact; download the
   `benchmarks` artifact's `raw.json`; run `bench-to-snapshot.ts` → filter to
   `tsgit` → write the baseline file (candidate #4 home) with a provenance line
   (runner OS/arch, CPU, Node, capture date). Commit it **in this feature's PR**.
   This is the ADR-483 clean-reference capture — **not** a personal-host run.
2. **Land the gate soft first** (candidate #2(b) / `continue-on-error:true`) for
   one or two PRs to observe real per-scenario deltas against the baseline on live
   PR runners, then tighten to the chosen posture (candidate #2) and N (candidate
   #3) once the observed noise band is known. This mirrors how `benchmark-compare`
   was introduced informational-first.
3. **Document the refresh procedure** (candidate #4 / Part F) so the next perf PR
   updates the baseline correctly (nightly-sourced, re-dated provenance, same-PR).

## Risks

- **Flake erodes trust.** If N is set below the true per-scenario noise, the gate
  cries wolf and gets ignored/disabled — the exact fate `benchmark-compare` was
  built to avoid. Mitigation: same-runner model (candidate #1(b)) + gross-only
  posture (candidate #2(c)) + N justified against measured nightly `rme`, and the
  soft-first rollout (step 2) to calibrate before blocking.
- **Baseline staleness.** A committed baseline (candidate #1(a)/#4) drifts as the
  hardware/Node/runner image changes; a stale baseline gates against a number no
  longer representative. Mitigation: provenance line dates it visibly (ADR-483
  pattern); refresh is a documented per-perf-PR step. Same-runner (#1(b)) has no
  baseline to stale — the base branch always is the baseline.
- **Maintenance burden.** Every legitimate perf change must remember to refresh the
  committed baseline (candidate #1(a)), or the gate blocks the improvement.
  Mitigation: candidate #1(b) removes the committed baseline entirely; if (a) is
  chosen, the refresh step must be in the release/PR checklist and the failure mode
  (gate blocks an improvement) is loud and self-explanatory.
- **Cross-env false positives** (candidate #1(a)). A PR runner slower than the
  nightly runner flags a phantom regression. Mitigation: this is precisely why the
  recommendation is same-runner (#1(b)); if (a) is chosen the N must sit above the
  cross-env band (candidate #3, N ≈ 25–30%), accepting the gate then catches only
  gross regressions.
- **`gh-pages` mishandling** (candidate #1(c)). Flipping `fail-on-alert` is
  low-touch but if the `alert-threshold` is tightened carelessly, every noisy main
  push fails. Mitigation: keep the trend job's threshold generous; do not delete or
  repurpose the `gh-pages` data branch.

## Out of scope

- **Publishing/refreshing the citable competitor numbers** — that is ADR-483's
  manual release-checklist step in `performance.md`; the gate protects tsgit's own
  perf surface, it does not publish comparison numbers.
- **A baseline-drift gate on the profile baseline** (`docs/perf/baseline.json`) —
  ADR-486 explicitly leaves the profile baseline a documentation artifact; this
  feature gates the **bench** surface (`snapshot.json`), not the profile surface.
- **Adding/removing bench scenarios** — the gate consumes whatever `raw.json`
  contains; new scenarios are a separate concern (and are handled gracefully as
  `new`).
- **N-competitor rendering / the `benchScenario` DSL shape** — the gate keys on
  `tsgit` benches only; the competitor-set question is `competitor-benchmarks.md`'s,
  not this feature's.
- **Any library/command surface change** — the gate is CI/tooling only; no
  `openRepository`/command option is added or changed (ADR-249 untouched).
