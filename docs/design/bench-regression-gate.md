# Design — Benchmark regression gate in CI

> Brief (backlog 26.5): "Regression gate in CI — `bench:summary` diff must not
> exceed ±N% per scenario." It closes the Phase-26 performance pass, **locking
> the final numbers**: it runs after every optimisation (26.4/26.4a/26.4b/26.4c/
> 26.7a) has landed and its job is to stop a future change from silently
> regressing the now-optimised perf surface. This is a **CI/tooling** feature —
> it adds no library or command surface.
> Status: draft → self-reviewed ×3 → **decisions ratified (ADRs 487–491)** →
> revised to match the ratified decisions (scope-fold).

This feature confronts one central tension: **the backlog asks for a blocking
per-scenario ±N% gate, but the entire existing perf apparatus is deliberately
non-blocking because CI bench noise is ~±20%** (ADR-483; the `benchmark-compare`
job is `continue-on-error`; `benchmark-snapshot` runs `fail-on-alert:false`). A
naive blocking gate with N < 20% flakes on every PR. The ADR conversation
resolved this by making the gate **advisory** (ADR-488) over a **same-runner
base-vs-PR** comparison (ADR-487), so no cross-environment offset (ADR-483's
uncitable case) enters the number and no committed baseline can go stale.

The five ratified decisions (ADRs 487–491) are summarised in **§Decisions
(ratified)** below; the rest of the doc specifies the change **as decided** — it
poses no open candidates.

## Context

The bench pipeline already exists end-to-end; this feature adds a **comparison
step** on top of it. There is **no committed baseline**: the base branch *is* the
baseline, and the gate reads **two** `raw.json` files (the base-branch run and the
PR-head run, both produced on one runner). The surface, verified against the live
tree in this worktree:

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
  machine-diffable, per-scenario, median-ms flattener the gate reuses on both
  sides.**
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
  full `fullName`. The gate keys on the full `snapshot.json` name (see §Design →
  key format).
- `bench.name` is exactly `tsgit` / `isomorphic-git`.
- `median`, `mean`, `min`, `hz`, `rme` are all present. `bench-to-snapshot.ts`
  uses `median ?? mean` (median-ms, smaller-better) — the gate metric (ADR-489).

**Existing CI perf jobs** (`.github/workflows/ci.yml`, Stage 7):

- **`benchmark-snapshot`** (push to main only): `test:bench` → `bench-to-snapshot.ts`
  → `benchmark-action/github-action-benchmark@v1`, `tool: customSmallerIsBetter`,
  `auto-push:true`, `gh-pages-branch: gh-pages`, `benchmark-data-dir-path: dev/bench`,
  `alert-threshold:'150%'`, `fail-on-alert:false`. **Trend tracking only.** The
  `gh-pages` branch is a dedicated benchmark-data store — **must not be
  repurposed/deleted** (deleting it breaks every main CI run at the snapshot step).
  **This job is untouched by this feature.**
- **`benchmark-compare`** (PR, `continue-on-error:true`): checks out the base sha,
  builds+benches it (`cp reports/benchmarks/raw.json /tmp/base-bench.json`), then
  checks out the PR branch, builds+benches it (`cp … /tmp/pr-bench.json`) **on the
  same runner**, then an **inline `node <<'SCRIPT'` heredoc** compares **ops/s**
  (`hz`) per `<group.fullName> > <bench.name>` key at threshold **5%**, writes a PR
  comment + `$GITHUB_STEP_SUMMARY`, and **never exits non-zero** (its own comment:
  *"same-runner benchmarking measures too much noise to block on."*). **This is the
  job this feature edits** (ADR-487, ADR-491): the two-checkout same-runner recipe
  and the `continue-on-error:true` posture are kept; the inline heredoc is replaced
  by an invocation of the new extracted, unit-tested tool.
- **`.github/workflows/bench.yml`** — the **nightly** benchmark (cron `14 3 * * *`
  UTC + `workflow_dispatch`), dedicated runner, no contention. **Untouched by this
  feature** — it is not a baseline source here (ADR-487 commits no baseline); it
  remains ADR-483's clean *publishing* reference for the hand-transcribed
  competitor numbers, which is a separate concern (§Out of scope).

**Governing prior art (read in full, not summarised from memory):**

- **ADR-483** (committed hand-transcribed benchmark snapshot): benchmarks are
  noisy (repo warns ±20% on GHA runners); a **personal host is not a reliable
  reference** (interactive-load bias — iso-git measured 1.2–2.4× slower under
  load); the **CI nightly (`bench.yml`) is the clean reference** for *published*
  numbers; **cross-environment comparison is the uncitable case**. ADR-487 reads
  this directly: a same-runner base-vs-PR ratio is load-independent (the systematic
  per-runner offset cancels), so it needs no committed baseline and no cross-env
  threshold widening.
- **ADR-486** (status:clean validation + baseline policy): a **same-host
  before/after ratio is load-independent** (both sides pay the same contention) —
  the method that proved "no regression" in the 26.7a investigation, and the exact
  method ADR-487 adopts for the gate. A committed whole-command profile baseline
  exists (`docs/perf/baseline.json`) but is a **documentation artifact with no CI
  gate** — and this feature does **not** gate it (§Out of scope).
- **`docs/design/competitor-benchmarks.md`** (house-style template + the
  `bench-summarize` / `bench-to-snapshot` surface map): bench files and `tooling/**`
  are **excluded from coverage** (`vitest.config.ts` coverage `include` =
  `src/{domain,ports,adapters/node,adapters/memory,operators}/**` only).
- **`docs/design/status-clean-perf-investigation.md`**: same-host before/after
  ratios are the load-bearing evidence; absolute local numbers are not citable.

## Constraints

1. **±20% CI-runner noise is the governing physical reality** (ADR-483). Any gate
   whose flag threshold approaches or falls below the per-scenario noise floor
   cries wolf. This is why the gate is **advisory** (ADR-488) — a flagged scenario
   is a prompt to look, never a merge blocker — and why the same-runner comparison
   (ADR-487), whose systematic offset cancels, lets N sit at ≈10% (ADR-489) rather
   than above the raw-noise floor.
2. **Cross-environment comparison is the uncitable case** (ADR-483). The gate
   sidesteps it entirely: **same-runner base-vs-PR** (ADR-487). There is **no
   committed baseline** captured on a different runner to drift or to compare
   across environments.
3. **`gh-pages` is load-bearing infrastructure** — the `benchmark-snapshot` trend
   store. Do not delete/repurpose it. This feature does not touch it.
4. **Faithfulness (ADR-226) is N/A here.** A benchmark **measures wall-clock
   time**; it asserts no git-observable behaviour, so this change pins **no
   faithfulness matrix** and adds **no interop test** (same reasoning as
   `competitor-benchmarks.md`). The only empirical matrix pinned is the `raw.json`
   **schema** above — a data-shape pin for the comparison tool, not a behaviour
   pin. Every fixture `git` invocation stays env-isolated exactly as today; this
   change adds no new `git`-spawning surface.
5. **ADR-249 (structured output, no cosmetics) is N/A to the library.** All
   comparison/threshold logic lives in `tooling/**` + `.github/workflows/**`; no
   `openRepository`/command option gains a gate/formatting job. The gate consumes
   the already-structured `raw.json` fields (`median`), it does not add a rendering
   surface to any command.
6. **No coverage/mutation obligation on the tooling.** `tooling/**` and
   `test/bench/**` are excluded from `vitest.config.ts` coverage `include`
   (precedent: `tooling/profile.ts`, `tooling/bench-memory.ts`,
   `bench-summarize.ts`, `bench-to-snapshot.ts`). The comparison tool's **pure
   helper** is nonetheless unit-tested (ADR-491) — it runs in the `test:unit` set
   but carries no coverage/mutation gate (see §Test strategy).

## Decisions (ratified)

Every load-bearing choice is settled by an ADR; this doc specifies the feature as
decided. (No ADR/phase/backlog number appears in any source/config/test — only
here and in the PR body.)

| ADR | Decision (one line) |
|---|---|
| **487** | **Same-runner base-vs-PR.** The gate benches the PR base branch and the PR head on **one runner** and compares per-scenario runtimes. **No committed baseline** — the base branch *is* the baseline; the gate reads **two `raw.json` files**. |
| **488** | **Advisory (non-blocking).** The gate computes and surfaces per-scenario deltas, flags any exceeding N, but the CI job keeps **`continue-on-error: true`** and **never blocks the merge**. N is a **reporting/flag threshold**, not a merge blocker. |
| **489** | **Metric = median-ms, asymmetric, one global N.** `deltaPct = (current_median_ms − base_median_ms) / base_median_ms × 100`; flag iff `deltaPct > N` (improvements never flagged); **one global N ≈ 10 %**, tunable. Reuses `toSnapshotEntries` for the flatten. |
| **490** | **Scope = `tsgit`-named benches only.** Filter to entries whose bench name is `tsgit` (key suffix `> tsgit`), dropping `isomorphic-git`. New scenario (in current, not base) → `new`, never flagged; missing (in base, not current) → `missing`, warned not flagged. |
| **491** | **Extracted pure function.** New `tooling/bench-check.ts` exports a pure `compareToBaseline(base, current, policy) → { rows, failed }` (no I/O); a thin `main()` does the I/O; unit-tested in `tooling/test/unit/bench-check.test.ts`. The CI job invokes it in place of the inline heredoc. `SnapshotEntry` gains an `export` so both modules share one type. |

## Design

### The diff surface — `snapshot.json`-shaped entries, not `summary.md`

The backlog says "`bench:summary` diff." Taken literally that means diffing
`summary.md`, a rendered human table with embedded `hz`/`rme` prose and a
timestamp line — brittle and semantically opaque. The gate instead compares the
**machine `{ name, unit:'ms', value }` entries** that `toSnapshotEntries` already
produces from `raw.json` (per-scenario, per-bench, median-ms). It flattens **both**
sides' `raw.json` through that one function; `summary.md` remains the human-facing
render, untouched. This is the ADR-249 discipline applied to the gate itself:
compare data, not the render.

### Comparison algorithm (ADRs 487–490)

The tool receives **two `raw.json` reports** — the base-branch run and the PR-head
run, both from the **same runner** (ADR-487). Given base `raw.json` and current
`raw.json`:

1. **Flatten each `raw.json` → entries** via the imported `toSnapshotEntries(raw)`
   — reuse it on **both** sides, do not re-implement the flattening (ADR-491).
2. **Filter each side to the gated bench set** (ADR-490). Keep only entries whose
   `bench.name` is `tsgit` — i.e. whose key ends in ` > tsgit`. iso-git entries are
   dropped before comparison (we do not control iso-git's code; its timing shifts
   are pure noise to a gate protecting tsgit).
3. **Join current ⋈ base on the per-scenario key.** The key is the full
   `snapshot.json` `name` (`<group.fullName> > tsgit`) — stable, already the
   snapshot format, unambiguous across scenarios.
4. **Per matched scenario, compute the regression delta** (ADR-489). With
   median-ms (smaller-better): `deltaPct = (current.value − base.value) /
   base.value × 100`. A **positive** delta is a regression (slower). Flag the
   scenario iff `deltaPct > N` — **asymmetric**: improvements (negative delta) are
   never flagged.
5. **Handle set mismatches** (ADR-490): a scenario **in base but missing from
   current** (renamed/removed, or a `SKIP`ped scenario the runner could not
   measure) → verdict `missing`, **warned, not flagged**; a scenario **in current
   but missing from base** (a *new* scenario) → verdict `new`, **passes** with a
   note — adding a bench never flags the gate.
6. **Aggregate.** `failed` is `true` iff any gated scenario is flagged `regress`.
   Emit a per-scenario table (scenario | base ms | current ms | delta% | verdict)
   to stdout + `$GITHUB_STEP_SUMMARY` + the PR comment.

The whole algorithm is a **pure function** over `(base, current, policy)`
returning `{ rows, failed }`; I/O (read both `raw.json` files, print the table,
signal via exit code) wraps it. That pure core is the unit-testable SUT
(§Test strategy). **`compareToBaseline`'s "baseline" argument is the base-branch
entries** (flattened from the base run's `raw.json`), **not a committed file** —
the name is historical; the value is always the same-runner base run.

### How the advisory tool signals (ADR-488 + ADR-491)

The tool is advisory, but it is also a normal CLI usable locally. To serve both:

- `main()` **prints the per-scenario table** and appends it to
  `$GITHUB_STEP_SUMMARY`; it **writes the PR-comment markdown** to the file the
  comment-posting step reads (mirroring today's `/tmp/bench-comment.md`).
- `main()` **exits non-zero iff `failed`** (any scenario flagged `regress`) — so a
  local `tooling/bench-check.ts base.json head.json` run is honestly red when a
  regression is flagged, which is useful during development.
- **The CI job keeps `continue-on-error: true`** (ADR-488), so that non-zero exit
  **does not block the merge** — GitHub records the step as failed-but-tolerated;
  the flag is surfaced via the comment + step summary, and acting on it is a human
  decision on the PR. This is the single, unambiguous contract: *the tool exits
  non-zero on a flagged regression; the advisory posture is enforced entirely by
  `continue-on-error: true` on the CI step, not by softening the tool.*

Rationale for exit-non-zero-plus-`continue-on-error` over exit-zero-always: it
keeps the tool honest for local use and future hardening (flipping
`continue-on-error` off is then a one-line change, per ADR-488's consequences)
without the tool needing to know whether it runs in CI.

### Key format — pin it once

`bench-to-snapshot.ts` keys on `<group.fullName> > <bench.name>`;
`bench-summarize.ts` shortens to the last ` > ` segment; the legacy
`benchmark-compare` heredoc keys on `<group.fullName> > <bench.name>` too. **The
gate reuses `toSnapshotEntries`'s key verbatim** (`<group.fullName> > tsgit` after
the `tsgit` filter) so the gate and the existing snapshot/trend surface speak one
key format. No new key scheme is introduced.

### Input interface — two `raw.json` paths as argv

Because the two runs come from **two checkouts on one runner** (ADR-487), the two
`raw.json` files already sit at two distinct paths (today `/tmp/base-bench.json`
and `/tmp/pr-bench.json`). The tool therefore takes **two file-path arguments**:

```
node --experimental-strip-types tooling/bench-check.ts <base-raw.json> <head-raw.json>
```

`main()` reads `process.argv[2]` (base) and `process.argv[3]` (head), each a
`raw.json`, and flattens both via `toSnapshotEntries`. It does **not** read a fixed
`reports/benchmarks/raw.json` path — that single-input shape belonged to the
now-moot committed-baseline design. Missing/extra argv → hard error with a usage
message (no swallowed error; §Error semantics).

### No wireit `bench:check` script (resolved)

A wireit `bench:check` script (dep `test:bench`, one fixed `raw.json` input) does
**not** fit this feature: the two inputs come from **two separate checkouts** in
CI, so there is no single working-tree `raw.json` for a wireit `files`/`output`
graph to key on, and no local `npm run` invocation produces both sides at once.
The CI job invokes the tool **directly** with two argv paths (§Part D). No
`package.json`/wireit change is required for the gate to run in CI. *(A convenience
`npm run bench:check -- <base> <head>` passthrough is possible but adds nothing the
direct `node …` invocation lacks; the plan may include it only as an optional
local-ergonomics nicety, not as a gate dependency — see Part C.)*

### Pre-chewed context blocks (every file the plan will touch)

**Part A — `tooling/bench-check.ts` (new).**
- Import `toSnapshotEntries`, `RawReport`, and `SnapshotEntry` from
  `./bench-to-snapshot.ts`. `toSnapshotEntries` and `RawReport` are already
  `export`ed (verified). **`SnapshotEntry` is declared but NOT exported** in
  `bench-to-snapshot.ts` — add `export` to that interface (a one-word diff; the
  generic converter is otherwise unaffected) so both modules share one type
  (ADR-491). Do not re-declare the shape locally.
- Export a pure `compareToBaseline(base: readonly SnapshotEntry[], current:
  readonly SnapshotEntry[], policy: { thresholdPct: number }): { rows:
  ReadonlyArray<{ key: string; baseMs: number | null; currentMs: number | null;
  deltaPct: number | null; verdict: 'pass' | 'regress' | 'new' | 'missing' }>;
  failed: boolean }`. Pure, deterministic, no I/O — the unit SUT. `failed` is
  `true` iff any row's verdict is `regress`.
- Filter helper `gatedEntries(entries)` → keep keys ending ` > tsgit` (ADR-490).
- `main()`: read the **two argv paths** (`process.argv[2]` = base `raw.json`,
  `process.argv[3]` = head `raw.json`), `JSON.parse` each, `toSnapshotEntries` →
  `gatedEntries` each side → `compareToBaseline` → print table to stdout, append to
  `$GITHUB_STEP_SUMMARY`, write the PR-comment markdown file → `process.exit(failed
  ? 1 : 0)`. Follow the `invokedDirectly()` guard idiom from `bench-to-snapshot.ts`.
- Mirror `bench-to-snapshot.ts`'s error handling: `main().catch` → stderr +
  `process.exit(1)`. Missing argv paths → throw a clear usage error (caught by the
  same handler). **No swallowed errors** (contract).
- **Tooling-import gotcha:** `bench-check.ts` imports only from another
  `tooling/*.ts` (`bench-to-snapshot.ts`), **not** from `src/`, so Node's
  `--experimental-strip-types` is fine (no parameter-property / `.js`-specifier
  issue).

**Part B — (removed).** *There is no committed baseline (ADR-487). The base branch
is the baseline; the gate reads two same-runner `raw.json` files. Any prior
"committed baseline file / home / format / provenance" content is struck — it no
longer exists in this design.*

**Part C — `package.json` scripts + wireit (optional, not a gate dependency).**
- **No wireit `bench:check` is required** — the CI job invokes the tool directly
  with two argv paths (§Part D), because the two `raw.json` files come from two
  checkouts, not one working tree (§"No wireit `bench:check` script").
- *Optional local-ergonomics only:* a plain (non-wireit) passthrough
  `"bench:check": "node --experimental-strip-types tooling/bench-check.ts"` invoked
  as `npm run bench:check -- <base> <head>` may be added for local convenience. It
  is **not** wired into any CI job and has **no** wireit `dependencies`/`files`/
  `output` (it cannot — there is no single `raw.json` input). The plan may include
  or skip it; nothing gates on it.

**Part D — `.github/workflows/ci.yml` — edit the existing `benchmark-compare` job.**
- **Keep** the whole same-runner recipe unchanged: `if` condition, `needs`,
  `runs-on`, `continue-on-error: true`, `permissions`, the "Checkout base branch →
  setup → build + bench base (`cp reports/benchmarks/raw.json /tmp/base-bench.json`)
  → checkout PR → `npm ci` → build + bench PR (`cp … /tmp/pr-bench.json`)" steps,
  and the "Post PR comment" step.
- **Replace only** the "Compare and comment" step body: delete the inline
  `node << 'SCRIPT' … SCRIPT` heredoc (the ops/s comparison, the untestable YAML
  logic, the past quote-collapse pain — ADR-491) and invoke the extracted tool:
  `node --experimental-strip-types tooling/bench-check.ts /tmp/base-bench.json
  /tmp/pr-bench.json`. The tool writes the PR-comment markdown file (same path the
  "Post PR comment" step reads) and appends to `$GITHUB_STEP_SUMMARY`.
- **Metric/scope/threshold change** (ADRs 489/490): the tool compares **median-ms**
  (not the heredoc's `hz`), **asymmetric** (improvements never flagged),
  **`tsgit`-only** (iso-git filtered out), at **N ≈ 10%** (not the heredoc's 5% on
  `hz`). The threshold is passed to the tool (env var like today's
  `REGRESSION_THRESHOLD`, or an argv/constant — the plan picks one; a single
  documented source).
- **Keep `continue-on-error: true`** (ADR-488): the tool exits non-zero on a
  flagged regression, but the job tolerates it — advisory, never a merge blocker.
- **Update the informative comment prose** on the job to reflect the new
  median-ms / asymmetric / tsgit-scoped / advisory behaviour (the current comment
  says "ops/s", "5%", "informative only" — keep "advisory / never blocks", correct
  the metric).
- `benchmark-snapshot` and `bench.yml` are **untouched**.

**Part E — `tooling/test/unit/bench-check.test.ts` (unit-tested per ADR-491; runs,
un-gated for coverage).**
- Unit-test the pure `compareToBaseline` with synthetic `SnapshotEntry[]` fixtures
  (deterministic, no bench run). `tooling/test/unit/**` **is** in the `test:unit`
  vitest `include`, so this executes alongside the rest; it is excluded only from
  the coverage `include`, so it carries no coverage/mutation gate. Mirror the
  fixture shape of `tooling/test/unit/bench-to-snapshot.test.ts` — but **do not**
  copy its `sut`-names-the-result mistake (see §Test strategy).

**Part F — docs (minimal).**
- `docs/understand/performance.md` (or the nearest perf-overview doc) gains a
  **one-line note** that a **same-runner, advisory** per-scenario regression check
  runs on PRs (median-ms, asymmetric, `tsgit`-scoped, N ≈ 10%, non-blocking), so a
  reader knows the check exists and that a flag is a prompt-to-look, not a blocker.
- **No baseline-refresh procedure** is documented — there is no committed baseline
  to refresh (ADR-487). *(The former "baseline refresh procedure" content is
  struck.)*

### Error semantics / edge behaviour

- **New scenario (in current, not in base)** → verdict `new`, **passes**, with a
  stdout note. Adding a bench never flags the gate (ADR-490).
- **Removed/renamed/skipped scenario (in base, not in current)** → verdict
  `missing`, **warned, not flagged** (ADR-490). A rename is a legitimate refactor;
  a `SKIP`ped scenario (e.g. `git`-absent `clone-small-repo`, or the Stryker
  sandbox) simply does not appear in that side's `raw.json` and must **not
  fabricate a regression**.
- **Missing argv path / unreadable `raw.json`** → hard error in `main()` with a
  clear usage/read message, non-zero exit (caught by `main().catch`). Not silently
  passed. (In CI this is tolerated by `continue-on-error`, but it surfaces loudly.)
- **Zero base value** (division guard) → verdict for that scenario is treated as an
  error/skip (`deltaPct: null`), never `Infinity`% — mirror `formatSpeedup`'s
  `b === 0 → 'n/a'` guard.
- **iso-git entries** → filtered out on both sides before comparison (ADR-490);
  they never contribute to a verdict.

## Test strategy

- **No coverage/mutation obligation.** `tooling/**` and `test/bench/**` are
  excluded from `vitest.config.ts` coverage `include`
  (`src/{domain,ports,adapters/node,adapters/memory,operators}/**` only) — same
  precedent as `tooling/profile.ts` / `tooling/bench-memory.ts` /
  `bench-summarize.ts` / `bench-to-snapshot.ts`. So `bench-check.ts` carries **no**
  coverage or mutation gate. Stated so review does not raise a false-positive
  coverage flag.
- **Unit test** for the pure `compareToBaseline` core in
  `tooling/test/unit/bench-check.test.ts` (ADR-491). **Sibling precedent:**
  `tooling/test/unit/bench-to-snapshot.test.ts` already unit-tests
  `toSnapshotEntries` with synthetic `RawReport` fixtures, and
  `tooling/test/unit/**/*.test.ts` **is** in the `test:unit` vitest project's
  `include` (verified) — so the test **runs** (coverage-excluded, not
  execution-excluded). **One caveat:** that sibling names the *result* `sut`
  (`const sut = toSnapshotEntries(...)`), which contradicts CLAUDE.md (`sut` = the
  function/object under test; result → `result`) — do **not** copy that mistake.
  Name the SUT `compareToBaseline` and the returned verdict `result`. Feed
  synthetic `SnapshotEntry[]` fixtures (no bench run):
  - Given a current entry N% slower than base **above** the threshold → verdict
    `regress`, `failed: true`.
  - Given a current entry N% slower **below** threshold → verdict `pass`,
    `failed: false`.
  - Given a current entry **faster** than base (negative delta) → `pass`
    (asymmetry proven — this test kills the "improvement flags" mutant).
  - Given a scenario in current but **not** base → verdict `new`, does not flag.
  - Given a scenario in base but **not** current → verdict `missing`, warns, does
    not flag.
  - Given a **zero base value** → guarded (`deltaPct: null`/skip), never `Infinity`.
  - Given a mixed set with an `isomorphic-git` entry alongside a `tsgit` entry →
    the iso-git entry is filtered out and never appears in `rows` (proves the
    `> tsgit` scope filter — ADR-490).
  - **Boundary isolation** (CLAUDE.md mutation-resistance): test **exactly at** the
    threshold and **one step either side** as separate tests — a single test
    straddling the boundary does not prove the `>` vs `>=` comparator. Assert the
    **numeric `deltaPct`** and the **verdict enum**, not just `failed` — a
    verdict-only assertion lets StringLiteral/comparator mutants survive.
  - Follow test conventions: `describe('Given …')` > `describe('When …')` >
    `it('Then …')`, AAA body, SUT named `sut` (the `compareToBaseline` function),
    result in `result`.
- **Property-test lens (CLAUDE.md) — lens 2 fits.** `compareToBaseline` is a
  **compositional aggregator** (reduces a set of per-scenario deltas to a `failed`
  verdict). A property is defensible and appropriate:
  - *empty gated set → `failed: false`* (identity element);
  - *appending one scenario whose delta exceeds N flips `failed` to `true`*;
  - *appending only improving (negative-delta) or below-N scenarios never flips
    `failed`* (asymmetry + threshold invariant).

  If the plan adopts it, a `bench-check.properties.test.ts` sibling (numRuns 100,
  invariant tier) next to the example test, generators in a co-located
  `arbitraries.ts` — **ungated**. It is **not** a round-trip pair, so lens 1 does
  not apply; the property must be stated as invariants, **not** by re-implementing
  the production reduction as the oracle (that would be a tautology).
- **No faithfulness matrix / no interop test.** The change asserts no
  git-observable behaviour (it measures wall-clock time and thresholds it), so per
  ADR-226 there is nothing to pin cross-tool. The only empirical matrix pinned is
  the `raw.json` **schema** (§Context) — a data-shape pin for the parser, recorded
  here, not in `test/integration/*-interop.test.ts`.
- **The gate itself is exercised by CI**, not by unit tests: the edited
  `benchmark-compare` job's same-runner base-vs-head run in the PR is the
  integration proof. Because this change is self-contained, **the very first PR's
  own base-vs-head run exercises the gate** — no separate rollout capture is needed.
  During development, a deliberately-lowered N on a scratch run proves the fail
  path (not committed).

## Rollout

The change is **self-contained** and needs no baseline capture (ADR-487): there is
no committed artifact to seed. Landing it is the rollout:

1. **Ship the extracted tool + unit test + the `benchmark-compare` edit** in this
   feature's PR. The PR's **own base-vs-head same-runner run** exercises the gate
   end-to-end on a live PR runner — the base branch is the baseline, so the gate
   runs against real data immediately, no seeding.
2. **Advisory from day one** (ADR-488): the job keeps `continue-on-error: true`, so
   even a flagged scenario on the introducing PR never blocks. Observe the real
   per-scenario deltas the first few PRs surface; **N ≈ 10% is tunable** in one
   place (ADR-489) if the observed same-runner band warrants it — a one-line change,
   no artifact to re-capture.
3. **If enforcement is ever justified** (the same-runner band proves tight enough),
   flipping `continue-on-error` off is a one-line future change (ADR-488
   consequence) — out of scope for this feature.

## Risks

- **Flake surfaces noise as a flag.** Same-runner cancels the systematic offset but
  not all variance; a genuinely noisy scenario can flag ≈10% spuriously. Mitigation:
  the gate is **advisory** (ADR-488) — a flag is a prompt to look, never a block —
  and N is tunable in one place (ADR-489). This is the exact failure mode
  `benchmark-compare` was built to tolerate, and this feature keeps that posture.
- **CI cost of the double bench.** Same-runner means the code PR builds+benches
  **both** the base branch and the head (ADR-487 consequence) — roughly double the
  bench time on code-changing PRs. Accepted: this cost already exists in today's
  `benchmark-compare` recipe (this feature reuses it verbatim), and same-runner is
  the only noise-honest comparison. No new cost is introduced by this change; the
  cost is inherited.
- **Advisory signal ignored.** An advisory gate can be waved through. Mitigation:
  the *quality* of the signal is the value (median-ms not `hz`, asymmetric,
  `tsgit`-scoped, unit-tested logic — ADRs 489/490/491); a consistent, reviewable
  per-scenario table on every code PR is more actionable than today's `hz` table,
  and enforcement remains a one-line flip away (ADR-488) if the band proves tight.
- **`gh-pages` mishandling.** Not a risk of *this* change (it touches neither
  `benchmark-snapshot` nor `gh-pages`), noted only to record that the trend store
  stays untouched.

## Out of scope

- **A committed baseline / baseline-refresh procedure** — ADR-487 commits no
  baseline; the base branch is the baseline. There is nothing to capture, home, or
  refresh.
- **Publishing/refreshing the citable competitor numbers** — that is ADR-483's
  manual release-checklist step in `performance.md`, sourced from `bench.yml`; the
  gate protects tsgit's own perf surface, it does not publish comparison numbers.
- **A baseline-drift gate on the profile baseline** (`docs/perf/baseline.json`) —
  ADR-486 explicitly leaves the profile baseline a documentation artifact; this
  feature gates the **bench** surface (same-runner base-vs-PR), not the profile
  surface.
- **Per-scenario thresholds** — ADR-489 ships one global N; per-scenario N is
  deferred until a specific scenario proves chronically noisy.
- **Making the gate blocking** — ADR-488 ships it advisory; flipping
  `continue-on-error` off is a future one-line change, not this feature.
- **Any library/command surface change** — the gate is CI/tooling only; no
  `openRepository`/command option is added or changed (ADR-249 untouched).
