# Design — Competitor benchmark comparison

> Brief: Publish a fair, reproducible head-to-head of tsgit vs isomorphic-git (and
> other pure-JS git libraries), fold a curated "Why tsgit" slice into the README, and
> document the methodology + caveats so the comparison stays honest. Deferred from 18.2;
> builds on the existing vs-isomorphic-git benches (11.1 `log`/`readBlob`/`status`,
> 12.4 `clone:small-repo`) and rides the Phase-26 stable-surface measurements.
> Status: draft → self-reviewed ×3 → ADRs 480–484 accepted → **revised in implementation** (see below).

> **Revision (implementation).** Measurement moved from a personal host (Apple M3 Pro, local
> `npm run bench:summary`) to the **CI nightly benchmark artifact** (`bench.yml`, a dedicated
> GitHub Actions runner). A personal host under interactive load biases tsgit's `lstat`-heavy
> paths: isomorphic-git — a pinned dependency whose code cannot change — itself measured
> 1.2–2.4× slower under load, and tsgit's syscall-heavy ratios shifted against it. The clean
> reference provenance is now `linux-x64` / AMD EPYC 7763 / Node 22.23.1 / isomorphic-git
> 1.38.7 (see [ADR-483](../adr/483-committed-hand-transcribed-benchmark-snapshot.md), revised).
> The clean numbers tell a **balanced 3-win / 3-loss** story — wins: `status:dirty` 1.22×,
> `readBlob:warm` 1.21×, `clone` 1.09×; losses: `log:walk` 0.78×, `readBlob:cold` 0.70×,
> `status:clean` 0.67×. `status:clean` flipped from the stale doc's 1.10× (a win) to a loss;
> this is traced to tsgit's **documented lstat containment-check cost** (a security property
> iso-git skips — see `../understand/performance.md`), *not* a confirmed new regression. A
> definitive same-host historical bench + profile is out of this docs-scoped change and is
> filed as a backlog follow-up. The README "Why tsgit" slice therefore frames the comparison
> as **competitive, wins on several ops, actively closing the gap on the rest** — never
> cherry-picking only wins (per [ADR-482](../adr/482-competitor-comparison-publication-surfaces.md)).

## Context

The bench suite already runs a tsgit-vs-isomorphic-git head-to-head — this change makes
that comparison *published, curated, and honest*, and decides whether the competitor set
grows beyond isomorphic-git. The relevant surface, verified against the live tree:

- **`test/bench/support/bench-dsl.ts`** — `benchScenario(given, whenThen, build, opts)`
  wraps vitest `describe` + `bench`. `BenchComparison = { sut; baseline? }`. It emits
  exactly two `bench()` calls with names **hard-keyed** to `'tsgit'` and
  `'isomorphic-git'` (lines 49–50); the header comment states the summary script, the
  `benchmark-compare` CI job, and the snapshot converter all key on those two names. Any
  third competitor requires touching this signature.
- **`test/bench/support/scaled-bench.ts`** — `resolveScaledContext(spec?)` +
  `scaledScenario(ctx, whenThen, build)`. Already generalised (26.6) to take an explicit
  `FixtureSpec`; `given` branches on `spec.strategy`. Not on the critical path for this
  change but the model to follow if new scaled comparison scenarios are added.
- **The comparison bench files** (verified by grepping which files actually emit an
  `isomorphic-git` `baseline` — the orchestrator's "four" undercounts; there are **eight**
  files that run a real head-to-head, split into a small-repo default set and a scaled
  set):
  - **Small-repo default set (6 scenarios, 4 files — this is what `performance.md`
    publishes today):**
    - `test/bench/log.bench.ts` — `repo.log()` vs `git.log({ fs, dir, depth })`,
      50-commit small repo from `setupSmallRepo`. 1 scenario.
    - `test/bench/read-blob.bench.ts` — cold (fresh `openRepository` per call) and warm
      (shared repo, primed LRU) `readBlob` vs `git.readBlob({ fs, dir, oid })`. 2
      scenarios.
    - `test/bench/status.bench.ts` — clean and dirty-25 `repo.status()` vs
      `git.statusMatrix({ fs, dir })`. 2 scenarios.
    - `test/bench/clone-small-repo.bench.ts` — full clone over a local `git-http-backend`
      CGI vs `git.clone({ fs, http, dir, url, singleBranch })`. Skips under Stryker / no
      `git-http-backend` / missing fixture (`SKIP` guard, lines 38–49). 1 scenario.
  - **Scaled comparison set (also emits iso-git baselines, via `scaledScenario`, gated by
    `TSGIT_BENCH_LARGE`; NOT in the published `performance.md` table):** `log-scale`,
    `status-scale`, `pack-read-scale` (×2), `delta-chain-read` (×2). Some go tsgit-only at
    large scale (iso-git too slow), leaning on `BenchComparison.baseline?` being optional.
  - **tsgit-only (no iso-git baseline — iso-git lacks the command):**
    `blame-deep-ancestry`, `describe`, `name-rev`. These are **not** comparison scenarios
    and must not appear in any head-to-head table.
  - **Implication:** the "published head-to-head" today is the **6 small-repo default
    scenarios**; a richer comparison surface already exists (the scaled set) but is
    gated/unpublished. Candidate #4 decides whether to publish only the 6 or promote some
    scaled comparisons.
- **`test/bench/fixtures.ts`** — `setupSmallRepo({ commits })` (seeds via tsgit's own
  writer, both libs read the same on-disk layout), `setupDirtyWorkingTree`,
  `setupDeepAncestryRepo`. `BenchRepo = { cwd; headCommitId; firstBlobId; cleanup }`.
  Fixed `AUTHOR` (name/email/timestamp/tz) → deterministic.
- **`tooling/bench-summarize.ts`** — reads `reports/benchmarks/raw.json`, emits the
  **two-column** `reports/benchmarks/summary.md`. `findByName(group, name)` looks up
  exactly `'tsgit'` and `'isomorphic-git'` (lines 45, 58–59); `renderRow` returns a fixed
  `| scenario | tsgit | isomorphic-git | speedup |` row and prints `_missing entry_` when
  either is absent; `formatSpeedup(a, b)` is pairwise (iso median ÷ tsgit median). The
  header row (lines 77–78) and the caveat footer (lines 81–84, incl. the "±20% variance"
  line) are literal. **This renderer is the load-bearing >2-competitor blocker.**
- **`tooling/bench-to-snapshot.ts`** — `toSnapshotEntries(raw)` flattens **every**
  `(group, bench)` pair generically into `{ name: '<group> > <bench>', unit: 'ms', value:
  median }`; **no competitor allow-list** — a third `bench()` name flows through
  automatically into `snapshot.json`.
- **`.github/workflows/ci.yml`** — `benchmark-snapshot` (main pushes → `test:bench` →
  `bench-to-snapshot.ts` → `github-action-benchmark@v1` → `gh-pages` `dev/bench`) and
  `benchmark-compare` (PRs, `continue-on-error`, base-vs-PR diff comment, **never blocks**
  — "same-runner benchmarking measures too much noise to block on"). Both extract
  benchmarks generically by group/bench name; neither has a two-competitor allow-list.
- **`.github/workflows/bench.yml`** — nightly (03:14 UTC). Restores the fixture cache
  (keyed on `fixture-generator.ts`), pre-warms `medium` + `delta-chain`, runs
  `bench:summary`, captures the memory probe, uploads `reports/benchmarks/`.
- **`package.json`** — `isomorphic-git@1.38.7` is the only competitor devDependency.
  Scripts: `test:bench` (→ `raw.json`), `bench:summary` (→ `summary.md`), `bench:fixture`,
  `bench:memory`. `summary.md` is generated locally, **not committed**.
- **`docs/understand/performance.md`** — carries a measured "Current measured numbers"
  table (6 scenarios, `darwin-arm64` / Apple M3 Pro), a Methodology section (names
  `isomorphic-git@1.38` explicitly), a "What tsgit optimises for" table, a "Why log /
  readBlob:cold are currently slower" honesty section, and a **Roadmap** line that scopes
  THIS item: "**26.7** — Side-by-side competitor benchmarks (`isomorphic-git`,
  `simple-git`, `wasm-git`, `nodegit`). Maintained per release." That roadmap enumeration
  is exactly what the pinned-installability matrix below re-litigates.
- **`README.md`** (65 lines) — deliberately lean. Has a "**Capabilities**" bullet list
  (no numbers today), no "Why tsgit" heading. `docs/BACKLOG.md` 18.2 states the README's
  "Why tsgit" is "**our numbers only, no competitor comparison (deferred to 26.7)**". So
  the 26.7 phrase "which currently ships our-numbers-only" is **aspirational** — the
  README ships *no* numbers today; the numbers live in `performance.md`. **This
  discrepancy is reconciled in candidate #2.**

Constraining prior art / ADRs:

- **ADR-226 (git-faithfulness prime directive)** — replicate git's observable behaviour
  byte-for-byte unless an ADR diverges. A benchmark **measures wall-clock time**; it
  asserts no git-observable behaviour, so this change is **not faithfulness-asserting** and
  pins **no faithfulness matrix**. The empirical matrix this design *does* pin is a
  **competitor-installability/API-shape matrix** (below) — evidence for the competitor-set
  decision, not a behaviour pin. Every fixture-building `git` call reused here stays
  env-isolated exactly as today (fixtures already are).
- **ADR-249 (structured output, not cosmetics)** — the library returns structured data;
  callers format. A benchmark comparison is *inherently* about rendered numbers and
  tables, which looks like a tension. **It is not:** the rendering lives entirely in
  **tooling/reports** (`bench-summarize.ts`, `performance.md`, `README.md`) and in the
  interop/bench harness, **never** in a command surface. No `openRepository`/command API
  gains a comparison-, formatting-, or rendering-bearing option. This framing is stated
  explicitly so the ADR conversation can ratify it: **26.7 adds zero library surface.**
- **11.1 / 12.4** — the existing comparison benches establish the head-to-head idiom this
  consolidates and publishes.
- **Bench files AND `tooling/` are excluded from coverage** — `vitest.config.ts` coverage
  `include` is `src/{domain,ports,adapters/node,adapters/memory,operators}/**` only.
  `test/bench/**` and `tooling/**` are never instrumented, so any bench-file edit, DSL
  change, summarizer change, or new tooling script carries **no coverage/mutation
  obligation** (same precedent as `tooling/profile.ts` / `tooling/bench-memory.ts`).
  Pure helpers extracted from a summarizer *may* get an optional `tooling/test/unit` test,
  but nothing gates them.

## Requirements

When this ships:

1. **A published, curated head-to-head table** exists in the tree comparing tsgit against
   at least isomorphic-git across the agreed scenario set, with per-scenario direction
   (faster/parity/slower) and a speedup figure.
2. The **README carries a "Why tsgit" slice** consistent with 18.2's intent — either a
   compact curated comparison table or a clearly-worded pointer to the full dataset
   (candidate #2 decides which; the README stays lean either way).
3. **`performance.md` remains the full dataset + methodology home**, updated so its
   Roadmap line and comparison-set claims match the *ratified* competitor set (not the
   aspirational four-name list).
4. The comparison **stays honest**: documented methodology, an explicit apples-to-oranges
   caveat for any non-pure-JS "reference point," host/date/version provenance on every
   published number, the existing "±20% variance / trust direction" caveat preserved, and
   a one-command regeneration path.
5. Every competitor added to the *runnable* bench set is **installable in CI without
   approving arbitrary native install scripts** and **runs deterministically** on the
   same on-disk fixture (or a documented equivalent); a competitor that cannot meet this
   is a *documented reference point*, not a runnable bench entry (candidate #1).
6. If the runnable competitor set grows beyond two, **`bench-summarize.ts` and the
   `benchScenario` DSL render N competitors** without printing `_missing entry_` for
   scenarios a given competitor cannot run (candidate #5). If it stays at two, no renderer
   change ships.
7. The published dataset is a **committed snapshot with provenance**, regenerable via a
   documented command; CI keeps producing the ephemeral nightly artifact but the *honest,
   citable* numbers are the committed snapshot (candidate #3).
8. **No library/command surface changes** — 26.7 touches only `test/bench/**`,
   `tooling/**`, `docs/**`, `README.md`, `package.json` (devDeps/scripts), and
   `.github/workflows/**`. ADR-249 framing (§Context) is preserved.
9. Every fixture `git` invocation stays env-isolated (author/committer/timestamp pinned,
   no `GIT_*` inheritance) — unchanged from today; this change adds no new `git`-spawning
   surface beyond what a runnable competitor (e.g. `simple-git`, which spawns the git
   binary) would itself invoke.

## Design

### Empirically-pinned competitor matrix (the crux — pinned, not remembered)

`performance.md`'s Roadmap names four competitors: `isomorphic-git`, `simple-git`,
`wasm-git`, `nodegit`. The brief says "isomorphic-git (and other **pure-JS** git
libraries)." Those two framings conflict — three of the four named are **not pure-JS**.
Pinned against the real npm registry + a real install in an isolated `mktemp -d`
throwaway (`darwin-arm64`, Node 22.22.3, git 2.55.0; throwaway removed after — nothing
written to the worktree):

| Candidate | Install result | Purity / runtime | Verdict |
|---|---|---|---|
| **isomorphic-git@1.38.7** | clean, 0 native deps (already a devDep) | **Pure-JS**, Node + Browser, JS git API (`git.log/readBlob/status/clone`) | **Runnable peer** — the only mature pure-JS peer |
| **simple-git@3.36.0** | clean, 7 pkgs | **Shells out** to the `git` binary via `child_process` (grep-confirmed in `dist/esm/index.js`); **no browser export** (`exports` = `.`, `./promise`); needs `git` on PATH | **Reference point only** — measures the native git binary, not JS; apples-to-oranges (it *is* git) |
| **nodegit@0.27.0** | 193 pkgs incl **12 deprecated/vulnerable** transitive (`request`, `inflight`, `har-validator`, `tar@4`, `glob@7`, `node-pre-gyp@0.13`…); **native install scripts BLOCKED** by npm's default policy → `require('nodegit')` = **`MODULE_NOT_FOUND`** (binding never built) | Native **libgit2** bindings; unusable without approving arbitrary install scripts + a node-gyp toolchain; no browser | **Exclude** — install-fragile, security-noisy, non-functional as-installed; would not survive CI's `npm ci` without a security exception |
| **wasm-git@0.0.16** | clean, 0 deps | Prebuilt **`lg2.wasm` (libgit2-in-WASM)** + emscripten loaders; no `main` field; emscripten `callMain`/MEMFS-OPFS virtual-FS API, not a JS git API | **Reference point only** — directly contradicts tsgit's **"Zero WASM"** headline claim; different API/FS model makes a same-fixture head-to-head structurally dishonest |

Load-bearing readings from this matrix:

- **isomorphic-git is the only honest runnable peer.** It is the only candidate that is
  pure-JS, cross-runtime, and exposes a JS git API that reads tsgit's on-disk fixture —
  the exact apples-to-apples the existing 6 scenarios already achieve.
- **simple-git and wasm-git are reference points, not competitors.** simple-git literally
  *is* the git binary (a wall-clock number for "how fast is native git" belongs in a
  caveat, not a peer column); wasm-git *is* libgit2 in WASM and undermines tsgit's own
  "Zero WASM" claim if presented as a peer. Both can be *cited* ("for reference, native
  git via simple-git clones in X ms; libgit2-via-WASM via wasm-git in Y ms") with an
  explicit apples-to-oranges label, but they should not share the head-to-head table's
  speedup column.
- **nodegit is excluded outright.** Its install is blocked by npm's security policy, pulls
  a dozen deprecated/vulnerable transitive deps, and does not load. Putting it in the
  runnable set would break `npm ci` in CI (which does not approve arbitrary install
  scripts) and violate the project's dependency-hygiene stance. This is empirical, not a
  reputation guess: `require()` returned `MODULE_NOT_FOUND` in the throwaway.
- **Consequence for `performance.md`:** the Roadmap line's four-name enumeration is
  **wrong to publish as-is** — it promises a comparison three of whose members cannot be
  fair. The design's recommendation is to correct that line to name the runnable peer
  (isomorphic-git) plus the *labelled reference points* (candidate #1 decides the exact
  set/framing).

> Isolation note: the matrix above was pinned in a `mktemp -d` throwaway with a private
> working dir under `/tmp`; installs touched only that dir; it was `rm -rf`'d after.
> Nothing touched the worktree, its `.git/config`, or any global npm/git config.

### Scenario set — consolidate the existing six, decide additions separately

Today's **published** comparison set is **6 small-repo scenarios**: `log`, `readBlob:cold`,
`readBlob:warm`, `status:clean`, `status:dirty`, `clone`. These already run
apples-to-apples (both libraries read the same tsgit-seeded on-disk fixture; `clone`
serves the same committed pack over the same CGI). A **scaled** comparison set already
*exists but is unpublished* (`log-scale`, `status-scale`, `pack-read-scale`,
`delta-chain-read` — gated behind `TSGIT_BENCH_LARGE`, some tsgit-only at large). **This
design's baseline recommendation is to publish exactly the six small-repo scenarios as the
honest comparison set** — they are stable-surface, already green, run on the default path
(no gate), and each already documented in `performance.md`. Promoting a scaled comparison
row, or adding *new* write-path scenarios (`commit`, `checkout`, `init`, `cat-file`), is a
*scope* decision (candidate #4), weighed against the "stays honest" mandate: each promoted
or new scenario needs an apples-to-apples framing (same fixture, equivalent options on both
libraries, and — for a scaled row that goes tsgit-only at large — an honest "not measured
against iso-git at this scale" label) or it silently biases the table.

The **`readBlob:cold` and `log:walk` scenarios currently show tsgit slower** (0.67× and
0.66× in `performance.md`). Publishing an honest head-to-head **must keep those rows** —
the comparison's credibility depends on showing the losses, not only the `status:dirty`
win. `performance.md`'s existing "Why log / readBlob:cold are currently slower" section is
the honesty template; the README slice (candidate #2) must not cherry-pick only wins.

### What the two published surfaces contain (data shapes)

**`performance.md` — the full dataset (unchanged home).** The existing "Current measured
numbers" table (6 rows, `tsgit | isomorphic-git | tsgit/iso`) is the canonical dataset.
26.7 refreshes the numbers against the stable Phase-26 surface, corrects the Roadmap
competitor enumeration (per candidate #1), and — if reference points are adopted — appends
a clearly-labelled "Reference points (not pure-JS peers)" sub-table citing simple-git
(native git) and/or wasm-git (libgit2-WASM) with the apples-to-oranges caveat. Provenance
(platform, Node version, CPU, iso-git version, date) already lives in the section header
and is preserved.

**`README.md` — the curated "Why tsgit" slice (candidate #2).** The lean README gets a
compact slice consistent with 18.2. The recommended shape is a **3-row curated table** (a
representative win, a parity, and an honest loss — e.g. `status:dirty` 1.95×,
`clone:small-repo` ~parity, `readBlob:cold` 0.67× slower) under a "Why tsgit" heading,
with a one-line link to `performance.md` for the full set and methodology. The slice must
carry the same "±20% variance — trust direction" caveat inline or by pointer so a
skimming reader is not misled. It stays ≤ ~10 lines to preserve the README's leanness.

### The >2-competitor renderer / DSL question (candidate #5)

If the runnable set grows past isomorphic-git (i.e. if a reference point is promoted to a
rendered column, or a second pure-JS peer ever appears), **two symbols block it**:

- **`benchScenario` in `test/bench/support/bench-dsl.ts`** — current signature:
  ```
  benchScenario(given, whenThen, build: () => BenchComparison, opts?)
  BenchComparison = { sut; baseline? }
  ```
  emits exactly `bench('tsgit', sut)` and `bench('isomorphic-git', baseline)`. An
  N-competitor shape would replace `baseline?` with a named map, e.g.
  `competitors?: ReadonlyArray<{ name: string; run: () => Promise<void> | void }>`, and
  emit one `bench(name, run)` per entry. All 6 existing call sites pass a single
  `baseline` and would need a mechanical migration (or a back-compat shim keeping
  `baseline?` as sugar for `[{ name: 'isomorphic-git', run }]`).
- **`tooling/bench-summarize.ts`** — `findByName(group, name)` (line 45), `renderRow`
  (lines 56–67, fixed 4-column row + `_missing entry_` fallback), `formatSpeedup(a, b)`
  (lines 50–54, pairwise), the fixed header (lines 77–78) and caveat footer (lines
  81–84). An N-competitor renderer would: derive the competitor column set from the union
  of `bench.name` values across groups (minus `'tsgit'`), render one column per
  competitor, render `—`/`n/a` (not `_missing entry_`) where a competitor did not run that
  scenario, and compute speedup **per competitor** against tsgit. `BenchGroup` (lines
  26–29) and `BenchEntry` (17–24) types are unchanged (already generic over `name`).
  `bench-to-snapshot.ts` needs **no change** — it already flattens every `(group, bench)`
  pair generically.

The design's **recommendation is to keep the runnable set at exactly two** (tsgit vs
isomorphic-git) and cite reference points as *prose numbers in `performance.md`*, so
**neither the DSL nor the summarizer changes** — the reference-point numbers are captured
by a one-off local script or manual measurement recorded in the doc, not by adding
`bench()` names. Candidate #5 lets the user overrule this and commit to the N-competitor
renderer now (with the pre-chewed migration above).

### Honest-measurement / reproducibility story (candidate #3)

Two facts constrain this: benchmarks are noisy (the repo already warns ±20% on GHA
runners; `benchmark-compare` is `continue-on-error` and never blocks), and the published
"Why tsgit" numbers must be *citable* — a number that changes every nightly run is not
citable. The design separates the two roles cleanly:

- **CI nightly (`bench.yml`) stays ephemeral** — it uploads `reports/benchmarks/` as a
  30-day artifact and feeds `github-action-benchmark` for trend tracking. Unchanged. This
  is the *trend* signal, not the *published* number.
- **The published numbers are a committed snapshot** — a `docs/understand/performance.md`
  table (and the README slice) carrying explicit provenance (platform, CPU, Node version,
  iso-git version, capture date), regenerated **on a documented single host** via
  `npm run bench:summary` and hand-transcribed into the doc, exactly as the current
  `performance.md` table already is (it cites `darwin-arm64` / Apple M3 Pro). This keeps
  the citable numbers stable and honest — they change only when a human re-measures and
  re-commits, with the provenance line updated. Candidate #3 decides whether to formalise
  a `reports/benchmarks/published.md` committed artifact + a `bench:publish` script, or
  keep the lightweight hand-transcribe-into-`performance.md` flow that already works.

**Caveats framing (fixed regardless of candidate outcomes):** the published surfaces
carry (a) the existing "±20% variance — trust direction more than absolute numbers" line,
(b) an explicit "re-run on your hardware" line, (c) for any reference point, an
apples-to-oranges label naming *what* it actually measures (native git binary /
libgit2-WASM, not a pure-JS peer), and (d) the honest losses (`readBlob:cold`,
`log:walk`) shown alongside the wins.

**Per-release maintenance (candidate #3 sub-question):** 26.7's brief says "Maintained per
release." The recommendation is **manual** — a documented "before a release, re-run
`npm run bench:summary` on the reference host and update the `performance.md` table +
README slice + provenance date" step in the release checklist — rather than a scripted
gate, because the numbers are host-specific artefacts (same reasoning that keeps
`benchmark-compare` non-blocking). A scripted per-release regeneration is a later,
optional hardening (adjacent to 26.5's regression gate), out of scope here.

### Pre-chewed context blocks (every file the plan will touch)

**Part A — `docs/understand/performance.md` (the full dataset + methodology).**
- Refresh the "Current measured numbers" table (lines 11–18) against the stable Phase-26
  surface; keep the 6-row shape and the provenance header (line 9).
- Correct the **Roadmap** line (line 68) — replace the four-name enumeration
  (`isomorphic-git, simple-git, wasm-git, nodegit`) with the ratified runnable peer +
  labelled reference points (per candidate #1). This is the single most important doc
  edit: it is the claim the pinned matrix falsifies.
- If reference points are adopted, append a "Reference points (not pure-JS peers)"
  sub-table + apples-to-oranges caveat after the main table.
- Update the Methodology "Comparison set" bullet (line 27) to state the runnable set is
  isomorphic-git-only (or +N per candidate #5) and reference points are cited separately.

**Part B — `README.md` (the curated "Why tsgit" slice).**
- Insert a "Why tsgit" heading with the curated 3-row table + pointer, per candidate #2.
  Current README has "Capabilities" (line 39) and "Documentation" (line 53); the slice
  sits between them or under a new heading. Keep it ≤ ~10 lines; preserve the lean tone.
- Must link to `docs/understand/performance.md` and carry the variance caveat by pointer.

**Part C — the runnable bench set (only if candidate #4 adds scenarios OR candidate #5
grows competitors).**
- New comparison scenarios follow the exact idiom of `log.bench.ts` / `status.bench.ts`:
  `benchScenario(given, whenThen, build)`, `build` boots a `setupSmallRepo` fixture +
  `openRepository`, registers `afterAll(dispose+cleanup)`, returns `{ sut, baseline }`
  where `sut` is the tsgit closure and `baseline` the `git.<op>(...)` call. New scenarios
  flow into `summary.md`/`snapshot.json` automatically (generic flatteners — verified).
- If candidate #5 grows competitors: migrate `benchScenario` (bench-dsl.ts) to the
  N-competitor shape above and update `bench-summarize.ts` `findByName`/`renderRow`/
  `formatSpeedup` to the N-column renderer above; add the new competitor to
  `package.json` devDependencies (only isomorphic-git today) — **but only a competitor
  that passed the installability gate** (Requirement 5); nodegit is excluded.

**Part D — `tooling/bench-summarize.ts` (only if candidate #5 grows competitors).**
- Rework `findByName`/`renderRow`/`formatSpeedup` per §"the >2-competitor renderer" above;
  keep `BenchGroup`/`BenchEntry` types; keep `bench-to-snapshot.ts` untouched (generic).
  A pure helper (e.g. "derive competitor column set from a group") is extractable and gets
  an optional `tooling/test/unit` test — nothing gates it (tooling is uncovered).

**Part E — `package.json` (scripts/devDeps).**
- If candidate #3 formalises a published artifact: add a `bench:publish` script (analogous
  to `bench:summary`) writing a committed `reports/benchmarks/published.md`. Otherwise no
  script change.
- devDependency change only if a new *runnable* competitor is adopted (recommendation:
  none — isomorphic-git already present).

**Part F — CI (`.github/workflows/*.yml`) — likely no change.**
- `bench.yml` and `ci.yml` extract benchmarks generically by group/bench name and upload
  `reports/benchmarks/` wholesale; adding scenarios needs no workflow edit. A new
  committed `published.md` (candidate #3) rides the existing `upload-artifact` path. Only
  if a *new runnable competitor devDep* is added AND it needs a runtime not present on the
  CI runner (none — isomorphic-git is pure-JS) would a workflow edit be required.

### Error semantics / edge behaviour

- **A competitor cannot run a given scenario** (e.g. no `git-http-backend` for `clone`, or
  a reference point that only does `clone`) → the scenario renders `—`/`n/a` for that
  competitor, never `_missing entry_` presented as a real result. The current summarizer
  prints `_missing entry_` when *either* of the two hard-keyed names is absent — under the
  N-competitor renderer this becomes a per-cell `—` so a partial competitor never blanks
  the whole row.
- **`git` binary absent** (would affect simple-git as a reference point, and the CGI
  clone) → that measurement is skipped and the doc notes "not measured on this host,"
  never a fabricated number. The existing `clone-small-repo.bench.ts` `SKIP` guard is the
  precedent.
- **iso-git impractically slow at scale** → for any scaled scenario, `baseline` stays
  optional (`BenchComparison.baseline?`), tsgit-only, exactly as `log-scale`/`status-scale`
  already do; the published table marks such rows tsgit-only. (Not in the recommended
  6-scenario small-repo set, but stated for completeness if candidate #4 adds a scaled
  comparison.)
- **Published number drifts from a fresh local run** → expected (±20% GHA / host
  variance); the caveat framing (§candidate #3) makes this explicit and the committed
  provenance line dates the snapshot, so a reader knows the number is a point-in-time
  measurement, not a live guarantee.
- **nodegit re-proposed later** → gated by Requirement 5 (installable in CI without
  approving arbitrary install scripts); the pinned matrix shows it fails that gate today.

## Decision candidates

Every candidate below is a **load-bearing choice not pre-decided by an existing ADR**;
the designer does not decide these — the user does, in the ADR phase. ≤3 alternatives
each, with a recommendation. (Next ADR numbers land at **480+**; highest existing is 479.)

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **Competitor set & purity framing** | (a) **isomorphic-git only** — the sole pure-JS peer; simple-git/wasm-git/nodegit dropped entirely. (b) **isomorphic-git as the runnable peer + simple-git & wasm-git as clearly-labelled "reference points"** (native git / libgit2-WASM) cited with apples-to-oranges caveats; nodegit excluded. (c) **all four** in one table. | **(b)** | Pinned matrix: iso-git is the only honest pure-JS peer; simple-git *is* the git binary and wasm-git *is* libgit2-WASM (contradicts "Zero WASM") — valuable as *reference context* but dishonest as peer columns; nodegit fails to install/load and drags 12 deprecated/vuln deps. (b) matches the brief's "and other pure-JS libraries" honestly while salvaging the roadmap's intent. |
| 2 | **Where the comparison lands** | (a) **Compact curated "Why tsgit" table in README** (win/parity/loss, ~3 rows) + full dataset in `performance.md`. (b) **Numbers stay in `performance.md`; README gets a pointer only.** (c) **Hybrid** — one headline stat sentence in README + link. | **(a)** | Backlog 26.7 explicitly says "fold into the README's Why tsgit section"; (b) contradicts that. (a) honours the fold while a ≤10-line, loss-inclusive slice preserves the README's leanness (18.2). (c) is a fallback if the user wants the README even leaner. |
| 3 | **Honest-measurement / reproducibility & maintenance** | (a) **Committed snapshot** — hand-transcribed into `performance.md`/README with provenance, regenerated via `npm run bench:summary` on a reference host; per-release manual refresh in the release checklist. (b) **Formalised committed artifact** — new `bench:publish` script → committed `reports/benchmarks/published.md`, referenced by the docs. (c) **CI-produced only** — docs link to the nightly artifact, no committed numbers. | **(a)** | Matches how `performance.md` *already* works (dated, host-pinned, hand-transcribed). Numbers must be citable/stable → not (c) (nightly numbers drift, artifact expires in 30d). (b) is a reasonable hardening but adds a script + committed report to maintain before 26.5's gate exists; defer unless the user wants it now. |
| 4 | **Scenario coverage** | (a) **Consolidate & publish the existing 6 small-repo scenarios** (`log`, `readBlob:cold/warm`, `status:clean/dirty`, `clone`) as the honest set. (b) **Also promote 1–2 already-existing scaled comparison rows** (`log-scale`, `status-scale`, `pack-read-scale`) with an explicit scale/gate label. (c) **Add new write-path scenarios** (`commit`, `checkout`, …) with equivalent options on both libs. | **(a)** | The 6 are stable-surface, green, already documented, default-path (no gate), and already apples-to-apples. (b) is low-cost since those scaled scenarios already run, but they are `TSGIT_BENCH_LARGE`-gated and some go tsgit-only at large — publishing them needs a clear scale caveat to stay honest. (c) needs a fair same-fixture/equivalent-options framing and iso-git's write API differs enough to risk unfairness; defer. |
| 5 | **Summarizer / DSL shape if >2 competitors** | (a) **Keep the runnable set at two** (tsgit vs iso-git); cite reference points as prose numbers in `performance.md` — **no DSL/summarizer change**. (b) **Commit to the N-competitor renderer now** — migrate `benchScenario` (`baseline?` → named-competitor list) + `bench-summarize.ts` (`findByName`/`renderRow`/`formatSpeedup` → per-column, per-cell `—`). (c) **Two runnable + a separate one-off reference-point script** writing its own tiny table. | **(a)** | Follows from candidate #1(b): reference points are *cited*, not *rendered as bench columns*, so the two-name hard-keying (bench-dsl.ts lines 49–50; bench-summarize findByName) never needs to change and stays mutation-clean. (b) only pays off if a *second pure-JS peer* ever appears — none exists today. (c) if the user wants reproducible reference-point capture without touching the main renderer. |
| 6 | **Reconciling the `performance.md` Roadmap line vs the brief** | (a) **Correct the Roadmap line** to name iso-git + labelled reference points (drop nodegit; label simple-git/wasm-git as non-peers). (b) **Leave it**, add a footnote. (c) **Delete the enumeration**, keep "competitor benchmarks." | **(a)** | The four-name line is empirically wrong to publish as a peer list (matrix). (a) makes the doc honest and self-consistent with the new dataset. (b) leaves a misleading claim standing; (c) loses useful reference-point context. |
| 7 | **ADR-249 "no cosmetics" framing for a benchmark comparison** | (a) **Ratify explicitly** that 26.7 adds zero library/command surface — all rendering is tooling/reports/README, ADR-249 is not in tension. (b) **Treat it as a genuine tension** and carve an ADR exception. | **(a)** | The comparison touches only `test/bench/**`, `tooling/**`, `docs/**`, `README.md`, `package.json`, `.github/**`; no `openRepository`/command option gains a formatting/comparison job. ADR-249 binds the *library surface*, which is untouched — so this is a clarifying ratification, not a divergence. Stating it forestalls a false-positive faithfulness/cosmetics flag in review. |

## Test strategy

- **Bench files and `tooling/` are excluded from coverage** (`vitest.config.ts` include =
  `src/{domain,ports,adapters/node,adapters/memory,operators}/**`). So any bench-file
  edit, the `benchScenario` DSL change (if candidate #5(b)), the `bench-summarize.ts`
  rework (if candidate #5(b)), and any new tooling script carry **no coverage or mutation
  obligation** — same precedent as `tooling/profile.ts` / `tooling/bench-memory.ts`.
- **If the N-competitor renderer is adopted (candidate #5(b))**, the pure column-derivation
  helper extracted from `bench-summarize.ts` is a good candidate for an optional
  `tooling/test/unit` test (given a synthetic `RawReport` with three bench names, assert
  the rendered table has three competitor columns and a per-cell `—` where a competitor is
  absent). Nothing *gates* it; it is welcome because it is a pure, easily-isolated
  function — unlike the host-specific number artefacts, which are not assertable SUTs.
- **No faithfulness matrix / no interop test** — this change asserts no git-observable
  behaviour (it measures wall-clock time), so per ADR-226 there is nothing to pin as a
  cross-tool interop test. The empirical matrix pinned here is a
  *competitor-installability* matrix (evidence for candidate #1), not a behaviour matrix;
  it lives in this doc, not in `test/integration/*-interop.test.ts`.
- **No property tests** — this touches no parser/matcher/round-trip pair; it is
  bench + reporting + docs. The CLAUDE.md property-test lenses explicitly exclude I/O and
  reporting wrappers.
- **The scenarios themselves are the "test"** — they must run green under
  `npm run test:bench` (the existing 6, plus any candidate-#4 additions) and skip cleanly
  when `git`/`git-http-backend` is absent or under Stryker (existing `SKIP` guards). Verify
  `reports/benchmarks/summary.md` still renders (two-column if candidate #5(a);
  N-column if #5(b)) and `snapshot.json` still flattens every pair.
- **Doc verification** — after refreshing `performance.md` + the README slice, confirm:
  the Roadmap line no longer promises an unfair four-way comparison (candidate #6); the
  README slice shows at least one honest loss alongside the wins; provenance (platform,
  Node, CPU, iso-git version, date) is present on every published table; the ±20%-variance
  caveat is present on both surfaces.
- **Reference-point numbers (if candidate #1(b))** are captured out-of-band (local one-off
  or manual) and recorded as *prose* with an apples-to-oranges label — not asserted, not
  gated, host-specific artefacts.

## Out of scope

- **CI regression gate (26.5)** — thresholding the `bench:summary` diff per scenario is a
  later item; here the numbers only need to be *published honestly*, not gated.
- **Bundle measurements (26.8)** — regenerable bundle-size/tree-shake artifacts are a
  separate item; `performance.md`'s bundle table stays as-is.
- **Per-command profile capture (26.3) / hot-path optimisations (26.4)** — 26.7 *reports*
  the stable-surface numbers those items produce/improve; it does not itself profile or
  optimise. The `readBlob:cold`/`log:walk` losses are published honestly, not fixed here.
- **Adding a native or WASM competitor to the runnable set** — nodegit (native, install-
  blocked) and wasm-git (WASM, contradicts "Zero WASM") are excluded from the runnable set
  by the pinned matrix; re-including either requires a future ADR clearing Requirement 5.
- **A benchmark-comparison option on any command/`openRepository` surface** — ADR-249
  keeps rendering in the caller/tooling; the library gains no comparison surface (candidate
  #7 ratifies this).
- **Automated per-release number regeneration as a blocking gate** — per-release refresh is
  a manual release-checklist step (candidate #3); a scripted gate is deferred to sit next
  to 26.5.
