# Design — Per-command profile capture (`npm run profile <cmd>`); commit baseline

> Brief: Extend `npm run profile` from its three hardcoded hot paths
> (`log`/`status`/`pack-read`) to profile *any single command by name* —
> `npm run profile <cmd>` — and commit a **portable** per-command performance
> baseline that the findings-driven hot-path work (26.4) and the CI regression
> gate (26.5) build on.
> Status: draft → self-reviewed ×3 → **decision candidates open** (this doc
> feeds the ADR conversation; nothing below is ratified yet).

## Context

Phase 26 (performance pass) instruments every command on medium + large
fixtures against a stable surface. The working order (BACKLOG §26) is: refactors
and the inflate spike de-risk first (26.1, 26.2, 26.10); known optimizations
land (26.4a, 26.4b, 26.11, 26.8); **memory-pressure scenarios join the bench
suite (26.6)**; then **every command is profiled to baseline the optimized
surface (26.3, this item)**; the findings-driven hot-path work (26.4) and the
competitor comparison (26.7) run on that baseline; the CI regression gate (26.5)
closes the perf work by locking the numbers. So 26.3 sits between a bench suite
that already covers the memory-pressure workloads and two downstream consumers
(26.4 findings, 26.5 gate) that depend on whatever baseline this commits.

### The existing profiler — `tooling/profile.ts`

The surface this change extends. Its shape:

- **Parent/child split.** Parent mode iterates a hardcoded
  `HOT_PATHS = ['log', 'status', 'pack-read']` triple; for each, spawns a
  `node --prof` child (`--child <path>`) in a `mktemp` work dir, post-processes
  the emitted `isolate-*.log` with `node --prof-process`, and writes the digest
  to `reports/profiles/<path>.txt`.
- **Child mode** opens the cached **medium** fixture
  (`ensureScaledFixture(MEDIUM_FIXTURE)`) and loops the one operation
  `CHILD_ITERATIONS = 100` times under the profiler. `log`/`status` re-run on a
  shared repo; `pack-read` re-opens a fresh repo per iteration and calls
  `primitives.readBlob(fixture.firstBlobId)`.
- **`dist/`-import pattern.** `openRepository` is dynamically imported from
  `dist/esm/index.node.js` — a strip-only runtime (`--experimental-strip-types`)
  cannot resolve `src/**`'s `.js`-suffixed specifiers to their `.ts` siblings
  nor parse `TsgitError`'s parameter-property constructor
  (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Hence the `profile` npm script is
  `npm run build && node --experimental-strip-types tooling/profile.ts`.
- **Fixture dependency + graceful degrade.** `main()` calls
  `ensureScaledFixture(MEDIUM_FIXTURE)` up front and, on failure, prints
  "install the `git` CLI and retry" and `process.exit(1)`.
- **Output is git-ignored and host-specific.** `reports/profiles/*.txt` is
  covered by `.gitignore`'s `reports/*` (the sole exception is
  `!reports/api.json`). The header comment already states captures are
  "host-specific".

### The bench + tooling neighbourhood (26.6 just landed)

- **`test/bench/support/fixture-generator.ts`** — the deterministic scaled-fixture
  generator (`git init` → `fast-import` → `checkout` → `repack`, cached under
  `~/.cache/tsgit-bench/<label>-v<N>`). Exposes `MEDIUM_FIXTURE` (5k commits /
  20k blobs / ~50 MB), `LARGE_FIXTURE` (50k / 200k / ~500 MB), `DELTA_CHAIN_FIXTURE`
  (300 commits, deep chains — added by 26.6), and `ensureScaledFixture(spec)`.
  `ScaledFixture = { cwd, headCommitId, firstBlobId, spec }`;
  `FixtureUnavailableError` when `git` is absent (callers `skipIf`).
- **`test/bench/support/scaled-bench.ts`** — `resolveScaledContext(spec?)`
  (26.6 generalised it to accept an explicit spec, defaulting to env-driven
  medium/large); `scaledScenario(ctx, whenThen, build)`.
- **`test/bench/*.bench.ts`** — the timing suite. Commands already exercised:
  `log` / `log-scale`, `status` / `status-scale`, `read-blob` /
  `pack-read-scale`, `clone-small-repo`, `describe`, `name-rev`,
  `delta-chain-read`. Each measures `tsgit` (and optionally `isomorphic-git`)
  wall-clock; the two `bench()` names MUST stay exactly `tsgit` /
  `isomorphic-git` (the summary script, snapshot converter, and
  `benchmark-compare` job all key on them).
- **`tooling/bench-summarize.ts`** — reads `reports/benchmarks/raw.json` (vitest
  bench output), emits a per-scenario markdown table
  `reports/benchmarks/summary.md`. **git-ignored.** Includes a machine banner
  (`process.platform-arch`, Node version, CPU model) and warns "GitHub Actions
  runners introduce ±20% variance — trust direction more than absolute numbers."
- **`tooling/bench-to-snapshot.ts`** — flattens `raw.json` into
  `customSmallerIsBetter` entries (`<group> > <bench>` → median ms),
  `reports/benchmarks/snapshot.json`. **git-ignored.** Generic — picks up new
  scenarios automatically.
- **`tooling/bench-memory.ts`** (26.6) — the closest sibling to this item: a
  standalone RSS/heap probe over two workloads, `dist/`-import, fixture-driven,
  emitting its **own committed-shape artifact** `reports/benchmarks/memory.{json,md}`
  (**both git-ignored**) — deliberately *never merged into* `bench-summarize.ts`'s
  timing summary. Run via `npm run bench:memory` =
  `npm run build && node --expose-gc --experimental-strip-types tooling/bench-memory.ts`.
- **`tooling/gen-bench-fixture.ts`** — `npm run bench:fixture -- <medium|large|delta-chain>`
  pre-warms a cache.

### The perf-tracking CI that already exists (and why "commit a baseline" is not already solved)

Two mechanisms exist — **neither is a committed, blocking, portable baseline**:

- **`benchmark-snapshot`** (`.github/workflows/ci.yml`, push to `main` only):
  `test:bench` → `bench-to-snapshot.ts` → `github-action-benchmark@v1` with
  `auto-push: true`, `gh-pages-branch: gh-pages`, `alert-threshold: '150%'`,
  **`fail-on-alert: false`**. History lives on the orphan `gh-pages` **data
  branch** (not the repo tree), and a regression only *comments*, never blocks.
- **`benchmark-compare`** (PR): same-runner base-vs-PR `raw.json` diff,
  **`continue-on-error: true`** — explicitly "informative only … same-runner
  benchmarking measures too much noise to block on."

`bench.yml` (nightly) pre-warms medium + delta-chain, runs `bench:summary` +
`bench:memory`, uploads `reports/benchmarks/` as a 30-day artifact. Nothing here
produces an **in-repo, diffable** baseline. So "commit a baseline" (26.3) is a
genuinely new artifact: 26.5's future "±N% per scenario, must not exceed" gate
needs something committed in the tree to diff a PR run against — the `gh-pages`
history and the same-runner compare are both non-blocking and off-tree by design.

### Constraining prior art / invariants

- **`.gitignore`**: `reports/*` is excluded with a single exception
  `!reports/api.json`. Any committed baseline needs either its own `!reports/…`
  exception line or a committed path **outside** `reports/`.
- **CLAUDE.md — structured output (ADR-249)** and **git-faithfulness (ADR-226)**:
  both bind the *library*. This item is **tooling-only** — the profiler consumes
  the existing structured `openRepository` API; it adds **no** command-surface
  option and asserts **no** git-observable behaviour. So no faithfulness matrix
  is pinned here. The one empirical pin below is a *tooling-behaviour* pin
  (what `node --prof-process` emits), not a git-behaviour pin.
- **Coverage / mutation**: `vitest.config.ts` coverage `include` is
  `src/{domain,ports,adapters/node,adapters/memory,operators}/**` only —
  `test/bench/**` and **`tooling/**` are never instrumented. So the extended
  `tooling/profile.ts` carries **no** coverage or mutation obligation, exactly
  as it doesn't today. A pure helper extracted from it (arg parsing, the
  baseline normalisation) *may* get an optional `tooling/test/unit` test, but
  nothing gates it.
- **26.6 sibling precedent** (`design/memory-pressure-bench-scenarios.md`):
  its Part E `bench-memory.ts` sets the pattern this item should echo — a
  standalone tooling script, `dist`-import, fixture-driven, emitting a
  **structured JSON + human markdown** pair as its own artifact, kept separate
  from the timing summary. 26.6 explicitly names "the general 26.3 per-command
  profile harness" as the broader item this is.

## The crux — what "commit a *portable* baseline" can mean, and the empirical pin behind it

`reports/profiles/*.txt` (V8 CPU digests) and `reports/benchmarks/{summary.md,memory.{json,md},snapshot.json}` are all **git-ignored and host-specific**. Committing any of them raw fails the "portable + diffable" bar. The load-bearing decision is **what portable form the committed baseline takes and where it lives** — surfaced as Decision candidate 1 below. This section pins the evidence that forces the decision; it does not decide it.

### Empirical pin — the `--prof-process` digest is irreducibly host-specific

Pinned by running `node --prof` over a fixed CPU-bound loop in a `mktemp`
throwaway (no worktree writes), then `node --prof-process` on the isolate log.
The digest head:

```
Statistical profiling result from isolate-0x…-v8.log, (66 ticks, 31 unaccounted, 0 excluded).

 [Shared libraries]:
   ticks  total  nonlib   name
     23   34.8%          /System/Library/Frameworks/CoreAudio.framework/Versions/A/CoreAudio
      6    9.1%          /Users/scolladon/.n/bin/node
 [JavaScript]:
      6    9.1%   16.2%  JS: *<anonymous> /private/var/folders/…/T/tmp.hBMc8ODA9I/work.js:1:1
 [Summary]:
      6    9.1%   16.2%  JavaScript
     29   43.9%          Shared libraries
     31   47.0%          Unaccounted
```

Load-bearing readings:

- **Absolute tick counts** (`66 ticks, 31 unaccounted`) are a function of CPU
  speed and sampling luck — they differ every run and every machine. A raw
  digest is not diffable across CI/dev.
- **Noise dominates the low-sample signal**: 47% Unaccounted + 44% Shared
  libraries + an OS framework (`CoreAudio`) outrank the code under test. The
  committable signal is **relative shares of *tsgit's own* frames**, not
  absolute ticks and not the shared-library/unaccounted noise floor.
- **Embedded absolute paths** (`/Users/scolladon/.n/bin/node`, the `mktemp`
  dir) are machine-specific — a committed digest would carry a developer's home
  path into the repo.

Conclusion the crux rests on: **a committed baseline cannot be a raw
`--prof-process` digest, a raw `bench-summarize` table, or a raw `snapshot.json`
with absolute ms.** It must be a *normalised, deterministic, structured extract*
— self-relative hot-function shares and/or normalised (ratio) timings — with a
machine banner recorded as metadata, not as the compared value. Which of the
normalised forms to commit, and where, is Decision candidate 1.

> Isolation note: the pin above wrote only inside `mktemp -d`; nothing touched
> the worktree's `.git/config`, any global config, or `reports/`.

## Requirements

When this ships:

1. `npm run profile <cmd>` profiles a **single named command** against the
   scaled fixture, replacing the hardcoded triple's *only* entry points with a
   name→operation resolution. The bare `npm run profile` (no arg) keeps a
   defined behaviour (Decision candidate 2).
2. The profilable-command set is **explicit and documented** — an unknown or
   unprofilable `<cmd>` fails fast with a clear message listing the valid set
   (Decision candidate 2), never silently no-ops.
3. A **portable, in-repo, diffable** per-command baseline is committed, in a
   form that survives a machine change (normalised, not absolute) and that 26.4
   (findings) and 26.5 (±N% gate) can consume (Decision candidate 1).
4. The baseline lives at a path that is **actually tracked by git** — either a
   new `!reports/…` exception in `.gitignore` or a committed path outside
   `reports/` (Decision candidate 1 sub-question).
5. The profiler reuses the existing fixture / `dist`-import / graceful-degrade
   machinery — **no** duplicated fixture generation, no second copy of the
   strip-only `dist`-import dance (Decision candidate 3).
6. The captured metric(s) per command are **stable enough to commit and diff**
   under a ±N% gate — their determinism story is stated, not assumed
   (Decision candidate 4).
7. **No library surface change.** No command gains a rendering/perf option; the
   profiler drives the existing structured API only (ADR-249/226 unaffected —
   confirmed, tooling-only).
8. Graceful degrade unchanged: `git` absent → clear message + non-zero exit;
   Stryker sandbox / missing fixture handled as today.

## Design

> The sections below describe the **recommended** shape for each decision so the
> planner has a concrete target; every load-bearing choice is *also* surfaced,
> un-decided, under Decision candidates. Where a candidate is open, the design
> text marks it "(recommended — DC-N)".

### D1 — Command→operation resolution and arg parsing (recommended — DC-2)

Replace the hardcoded `HOT_PATHS` triple with an **explicit registry** mapping
a profilable command name to a *closure that performs one representative unit of
work* against a resolved fixture:

```
type ProfileWorkload = {
  readonly fixture: FixtureSpec;                   // which scaled fixture to open
  readonly setup?: (fixture) => Promise<unknown>;  // env-isolated, idempotent preamble
                                                   // (e.g. describe/name-rev tag) → resolved arg
  readonly run: (repo, fixture, arg) => Promise<void>; // one representative unit
  readonly perIterationRepo?: boolean;             // re-open per iter (cold-read paths)
  readonly iterations?: number;                    // override CHILD_ITERATIONS for slow cmds
};
const WORKLOADS: Record<string, ProfileWorkload> = { log, status, 'pack-read', … };
```

- **The set is the read-only, idempotent commands** that can loop N times in
  place without mutating repo state: `log`, `status`, `pack-read`
  (today's three — note `pack-read` names the cold `readBlob` regime, a
  fresh-repo-per-iteration read of `fixture.firstBlobId`, distinct from any
  warm-cache read) plus the read commands the bench suite already covers —
  `describe`, `name-rev`, `blame`, `diff`, `show`, `cat-file`, `rev-parse`.
  Write/network commands (`commit`, `add`, `clone`, `fetch`,
  `push`, `merge`, …) are **excluded from the loopable registry** because
  looping them mutates state / hits the network — their profile shape is a
  different design (per-iteration fresh repo + teardown, or clone-small-repo's
  one-shot form). Exactly *which* commands populate the initial registry, and
  how write commands are handled (excluded vs one-shot-with-fresh-repo), is
  **DC-2**.
- **Arg parsing**: `process.argv` after `--child` stays the child-mode marker;
  the parent reads `process.argv[2]` as `<cmd>`. Unknown `<cmd>` → print
  `usage: profile <cmd> (one of: …)` + `process.exit(1)` (mirrors
  `gen-bench-fixture.ts`'s exact idiom).
- **Per-command preamble (a real, load-bearing wrinkle).** The raw medium
  fixture is a plain linear history with one `main` ref and **no tags**, so
  several read commands cannot be profiled by a bare call: `describe` and
  `name-rev` need a tag/target to resolve against. The bench suite already pays
  this — `describe.bench.ts` (`ensureNearTag`) and `name-rev.bench.ts`
  (`ensurePrunableTaggedTip`) each run env-isolated `git tag` / `commit-tree`
  preambles on the fixture before the workload. So a `ProfileWorkload` needs an
  **optional `setup(fixture)` preamble** and the workload closure may take a
  resolved target/arg. Two consequences the planner must weigh (folds into
  **DC-2** population): (1) any preamble that spawns `git` is a **new
  git-invocation surface** and MUST be env-isolated exactly as the bench
  preambles are (scrub `GIT_*`, pin author/committer/date, `GIT_CONFIG_NOSYSTEM=1`)
  — the profiler does not spawn `git` today, so this is net-new isolation
  surface; (2) preambles mutate the **shared, cache-keyed** fixture, so they must
  be **idempotent** (the bench preambles use `tag -f` / deterministic
  `commit-tree` so the cache never grows) — never regenerate or corrupt the
  shared cache. Commands with no clean idempotent preamble against the medium
  fixture are candidates to **omit** from the initial registry (DC-2).
- **Per-command iteration count.** `CHILD_ITERATIONS = 100` is fine for `log` /
  `status`; a slow command (e.g. `blame` over a 5k-commit file) at 100 iters
  under `--prof` may be impractically slow. The registry entry may carry an
  optional per-workload iteration override; a sensible default (100) applies
  otherwise. Minor — folds into the registry shape (DC-3 rec.).
- **No-arg behaviour** (`npm run profile`): **DC-2** — profile the full
  registry (backward-compatible superset of today's triple) vs profile only the
  legacy triple vs require an explicit arg. Recommended: **profile the full
  registry** so `npm run profile` remains the "baseline everything" entry point
  and `npm run profile <cmd>` narrows to one — this is what makes one command
  regenerate its own baseline slice for 26.4's tight findings loop. (Note this
  changes today's runtime/output — it profiles *more* than the legacy triple —
  even though the triple is still covered.)

### D2 — What is captured, and its determinism (recommended — DC-4)

Two candidate signals, both already reachable without new library code:

- **CPU hot-function shares** — from the existing `--prof` / `--prof-process`
  path, but **parsed** into a structured `{ frame → self% }` map filtered to
  *tsgit's own* frames (drop Shared-libraries / Unaccounted / node-internal
  noise per the empirical pin), self-normalised so the shares sum over the
  tsgit surface. Deterministic *in rank/share* across machines even though
  absolute ticks are not (that is exactly why shares, not ticks).
- **Normalised wall-clock** — reuse the `bench:summary` timing but store the
  **ratio** form (per-scenario tsgit-vs-baseline speedup, already computed by
  `bench-summarize.ts`), which cancels most machine speed. Absolute ms is *not*
  committed; the ratio and a recorded machine banner are.

Which signal(s) the committed baseline carries is **DC-4**. Recommended: commit
**hot-function self-shares** as the primary per-command baseline (this is what
26.4 acts on — "function X is 40% of `log`, optimise it") plus the machine
banner as metadata; leave absolute timing to the existing (non-committed)
snapshot/nightly pipeline. Rationale: shares are the most machine-portable
signal the pin identified, and they are precisely the "findings" 26.4 consumes.

### D3 — Relationship to the bench suite and where the tool lives (recommended — DC-3)

**Extend `tooling/profile.ts` in place** rather than fork a new tool or fold
into `bench-summarize.ts`:

- `profile.ts` already owns the `--prof`/`--prof-process` capture, the
  parent/child spawn, the `dist`-import, and the fixture graceful-degrade — the
  per-command generalisation is a **registry swap + a digest parser + a baseline
  writer**, not a new machine.
- It must **not** be folded into `bench-summarize.ts`: that script keys on the
  `tsgit`/`isomorphic-git` bench names and only knows wall-clock ms; CPU
  hot-shares are a different signal (the 26.6 precedent kept `bench-memory.ts`
  separate for exactly this reason — one artifact, one signal).
- Fixture reuse: `ensureScaledFixture` + the `FixtureSpec` values are imported
  unchanged; no fixture generation is duplicated. The registry references
  `MEDIUM_FIXTURE` (default) and may reference `DELTA_CHAIN_FIXTURE` /
  `LARGE_FIXTURE` for paths that want them.

Whether the tool is `profile.ts`-extended vs a new `tooling/profile-baseline.ts`
vs a `bench-summarize` extension is **DC-3**. Recommended: extend `profile.ts`.

### D4 — Where the committed baseline file lives and its shape (recommended — DC-1)

The committed artifact is a **structured JSON** (machine-diffable) with a sibling
human-readable markdown, mirroring the 26.6 `memory.{json,md}` pair:

- **Shape** (recommended): per command, the normalised hot-function shares +
  metadata banner:
  ```
  {
    "generatedOn": "linux-x64 / node vX / <CPU>",   // metadata, NOT compared
    "commands": {
      "log":    { "hotShares": [ { "frame": "walkCommitsByDate", "self": 0.41 }, … ] },
      "status": { "hotShares": [ … ] }, …
    }
  }
  ```
  Absolute ticks/ms are deliberately excluded (the pin: non-portable). 26.5
  diffs `self` shares per frame within a ±N% band; 26.4 reads the top frames as
  its optimisation targets.
- **Location** (recommended): commit **outside `reports/`** — e.g.
  `docs/perf/baseline.json` (or a `perf/` top-level) — so it needs no
  `.gitignore` surgery and reads as a deliberate, reviewed artifact rather than
  a stray un-ignored report. Alternative: add `!reports/perf-baseline.json` to
  `.gitignore` (mirrors the `!reports/api.json` precedent). Both the **shape**
  and the **location** are **DC-1** (the crux) — recommended above, but **not
  decided here**.

### D5 — Wiring into 26.4 and 26.5

- **26.4 (findings-driven hot-path work)** consumes the committed per-command
  hot-shares directly: "the baseline says frame X is N% of command Y" is the
  *only* license 26.4 has to touch a hot path (no speculative work). Regenerating
  one command's slice via `npm run profile <cmd>` after a change confirms the
  share moved. No new wiring — 26.4 reads the committed JSON.
- **26.5 (CI regression gate)** diffs a fresh capture against the committed
  baseline, failing when any scenario's tracked metric exceeds ±N%. The gate
  script and threshold are **26.5's** to design; 26.3 only guarantees the
  baseline is (a) committed in-tree, (b) in a diffable structured shape, (c)
  normalised so a CI machine's capture is comparable to the committed one. The
  choice of *which* metric the gate keys on (hot-shares vs normalised timing)
  falls out of DC-4.
- **CI regeneration cadence** is out of scope here (26.5 decides whether the
  gate regenerates on a fixed runner or compares committed-vs-fresh); 26.3 only
  produces the artifact and the `npm run profile <cmd>` regeneration path.

### Error semantics / edge behaviour

- **Unknown `<cmd>`** → `usage: profile <cmd> (one of: …)` + exit 1 (no silent
  no-op; mirrors `gen-bench-fixture.ts`).
- **`git` absent / fixture unavailable** → the existing `ensureScaledFixture`
  try/catch prints "install the `git` CLI and retry" + exit 1 (unchanged).
- **Stryker sandbox** (`STRYKER_MUTANT_ID`) → not applicable; tooling is not
  mutated. No behaviour needed.
- **A profilable command that throws** under the profiler → the error surfaces
  loud (spawn non-zero close), never swallowed — as today.
- **Digest with no tsgit frames above the noise floor** (e.g. a trivially fast
  command at N=100 iterations) → the parser records an empty/short `hotShares`
  with a warning, rather than fabricating shares; whether such a command belongs
  in the registry at all is a DC-2 population question.

## Decision candidates

Every load-bearing choice not pre-decided by existing ADRs is below, each with
≤3 options and a recommendation. **These are for the ADR conversation — none is
decided in this doc.**

### DC-1 — Committed-baseline form & location (the crux)

**Question:** What portable form does the committed per-command baseline take,
and where does it live, given raw digests/summaries are host-specific and
git-ignored?

- **(a) Structured JSON of normalised hot-function self-shares + metadata
  banner, committed outside `reports/`** (e.g. `docs/perf/baseline.json`), with
  a sibling human markdown. Portable (shares, not ticks — per the pin),
  diffable, no `.gitignore` surgery, reads as a reviewed artifact. 26.4 reads
  top frames; 26.5 diffs shares within ±N%.
- **(b) Reuse/extend `bench:summary`'s output, committed in a normalised
  (ratio) form** under a new `!reports/…` `.gitignore` exception. Leans on
  existing timing machinery, but couples the baseline to wall-clock ms (needs
  ratio normalisation to be portable) and keeps it in the `reports/` noise zone.
- **(c) Commit only self-relative hot-function shares (%), no timing at all**,
  as the narrowest portable artifact (location per (a) or (b)). Maximally
  machine-independent; drops any committed timing signal (timing stays in the
  existing non-committed nightly/snapshot pipeline).

**Recommendation: (a).** The empirical pin shows shares are the portable signal
and are exactly what 26.4 consumes; committing outside `reports/` avoids
`.gitignore` surgery and signals intent. (c) is (a) minus the metadata framing;
(b) drags in the least-portable signal (absolute ms) and the `reports/` noise.
The location sub-question (`docs/perf/` outside `reports/` **vs** a
`!reports/perf-baseline.json` exception mirroring `!reports/api.json`) is part
of this DC.

### DC-2 — `profile <cmd>` command selection & no-arg behaviour

**Question:** Which commands are profilable, how does `<cmd>` resolve to an
operation, and what does `npm run profile` (no arg) / an unknown `<cmd>` do?

- **(a) Read-only registry only** — `log`, `status`, `pack-read` (cold
  `readBlob`) + the read commands the bench suite already covers (`describe`,
  `name-rev`, `blame`, `diff`, `show`, `cat-file`, `rev-parse`). Write/network
  commands excluded (looping them mutates state / hits the network). No-arg =
  profile the whole registry; unknown = usage + exit 1.
- **(b) Read-only registry + one-shot write commands** — additionally profile
  write commands (`commit`, `add`, `merge`, …) with a *fresh repo per iteration*
  + teardown (like `clone-small-repo`'s one-shot bench). Broader coverage, but a
  materially more complex harness (per-iteration setup cost pollutes the profile;
  needs a scratch-repo factory).
- **(c) Keep the legacy triple as the no-arg default; `<cmd>` opts into a wider
  set** — smallest diff to today's behaviour, but leaves most read commands
  unprofilable unless named, and splits "what `profile` does" from "what
  `profile <cmd>` does".

**Recommendation: (a).** A read-only registry is idempotent-loopable (the whole
premise of N-iteration profiling), covers the commands 26.4 will most plausibly
optimise, and keeps the harness simple. No-arg profiles the full registry
(superset of today's triple → backward compatible). Write-command profiling
((b)) is a real but separable design — flag it as a possible follow-up, don't
fold it in.

### DC-3 — Relationship to the existing bench suite / where the tool lives

**Question:** Is per-command profile capture a new tool, an extension of
`profile.ts`, or folded into `bench-summarize.ts`?

- **(a) Extend `tooling/profile.ts` in place** — it already owns the
  `--prof`/`--prof-process`/`dist`-import/graceful-degrade machinery; the change
  is a registry swap + digest parser + baseline writer.
- **(b) New `tooling/profile-baseline.ts`** alongside `profile.ts` — cleaner
  single-responsibility split (capture vs baseline emission), but duplicates the
  spawn/`dist`-import/fixture scaffolding (or requires extracting it to a shared
  helper first).
- **(c) Fold into `bench-summarize.ts`** — rejected: that script only knows
  wall-clock ms and keys on `tsgit`/`isomorphic-git` bench names; CPU hot-shares
  are a different signal (26.6 kept `bench-memory.ts` separate for this reason).

**Recommendation: (a).** Smallest surface, zero duplication, reuses every
already-proven idiom. If the planner finds the digest-parser + baseline-writer
grows large, extracting a pure helper into `tooling/` (optionally unit-tested
under `tooling/test/unit`, though ungated) is the natural refinement — still
within (a).

### DC-4 — Metric(s) captured per command & their determinism story

**Question:** What does the committed baseline measure (wall-clock? allocations?
hot-function shares?), and what makes it stable enough to commit and diff under
a ±N% gate?

- **(a) CPU hot-function self-shares** — parsed from `--prof-process`, filtered
  to tsgit frames, self-normalised. Machine-portable (shares, not ticks — per
  the pin), directly actionable by 26.4. Requires a robust digest parser
  (the `[Bottom up (heavy) profile]` / `[Summary]` sections).
- **(b) Normalised wall-clock ratio** — reuse `bench-summarize`'s per-scenario
  tsgit/baseline speedup ratio (cancels machine speed), commit the ratio + a
  banner. Simpler (no digest parsing), but a coarser findings signal and still
  carries measurement noise (±20% runner variance the summary itself warns of).
- **(c) Both — hot-shares as primary + normalised ratio as secondary** — richest
  baseline, but doubles the artifact surface and the 26.5 gate's decision (which
  metric trips the gate?).

**Recommendation: (a)** as the committed baseline's primary signal, with the
machine banner as metadata. It is the most machine-portable signal the pin
identified and is precisely the "findings" 26.4 acts on. If a committed timing
signal is wanted, (c) is acceptable but should keep hot-shares as the gate's
key metric and timing as advisory.

### DC-5 — Faithfulness / structured-output (ADR-249/226) confirmation

**Question:** Does any part of this touch the library's command surface or
git-observable behaviour?

- **(a) Confirm tooling-only** — no command gains a rendering/perf option; the
  profiler consumes the existing structured `openRepository` API; no git
  behaviour is asserted, so no faithfulness matrix is pinned. (This is the
  design's position throughout.)

**Recommendation: (a).** Stated for completeness so the ADR conversation
records that ADR-249/226 are confirmed *unaffected* — not because there is a
live choice. The only empirical pin in this doc is the *tooling-behaviour* pin
(what `--prof-process` emits), which is not a git-faithfulness pin. The one
residual git-invocation surface — a `describe`/`name-rev` `setup` preamble (DC-2)
— carries an **env-isolation** obligation (scrub `GIT_*`, pinned dates,
`GIT_CONFIG_NOSYSTEM=1`, idempotent against the shared cache), following the
existing bench preambles; it asserts no git output, so it is not a faithfulness
pin.

## Test / faithfulness plan

- **No faithfulness matrix, no interop test.** This item asserts no
  git-observable behaviour (it measures tsgit's own CPU profile) — per the
  faithfulness stance, only behaviour-asserting changes get an interop pin.
  ADR-249/226 are confirmed unaffected (DC-5).
- **Env-isolation of any new `git` preamble** (DC-2). If the registry gains a
  `setup(fixture)` preamble that spawns `git` (as `describe`/`name-rev` require —
  no tags on the raw fixture), it MUST scrub `GIT_*`, pin author/committer/date,
  and set `GIT_CONFIG_NOSYSTEM=1`, exactly as `describe.bench.ts` /
  `name-rev.bench.ts` do, and be **idempotent** against the shared cache-keyed
  fixture (`tag -f` / deterministic `commit-tree` — never grow or corrupt the
  cache). This is the *only* new `git`-invocation surface the item adds; it is an
  isolation obligation, not a faithfulness pin (no git output is asserted).
- **Coverage / mutation: none mandated.** `tooling/**` is outside the coverage
  `include`, exactly as `profile.ts` is today. If the digest-parser or arg
  resolver is extracted as a pure helper, an *optional* `tooling/test/unit` test
  is welcome (e.g. "given this fixed `--prof-process` digest text, the parser
  yields these tsgit-frame shares"; "given `<cmd>=foo`, the resolver rejects
  with the usage message") — but nothing gates it, and profile numbers
  themselves are host-specific artefacts, not assertable SUTs (same reasoning as
  today's `profile.ts` output).
- **The tool is verified by running it**, not by an assertion: `npm run profile`
  profiles the full registry and writes the committed baseline; `npm run profile
  <cmd>` narrows to one and regenerates that slice; an unknown `<cmd>` prints the
  usage list + exits non-zero; `git` absent degrades with the clear message +
  exit 1. Confirm the committed baseline file is deterministic in *shape*
  (frame set + share ordering) across two runs on the same machine, and that its
  committed path is actually tracked (not swallowed by `.gitignore`).
- **No property tests** — this is I/O + capture + generation tooling; the
  CLAUDE.md property-test lenses (round-trip / matcher / total-function /
  idempotence over a grammar) do not fit generation wrappers.
- **State-mutating probes stay in `mktemp`** — the one empirical pin in this doc
  (the `--prof-process` host-specificity check) ran in a `mktemp -d` throwaway;
  no worktree / global-config / `reports/` writes.

## Out of scope

- **The 26.5 CI regression-gate script + threshold** — 26.3 commits the
  baseline and the `npm run profile <cmd>` regeneration path; the gate that
  diffs a CI capture against it (±N% per scenario, the failure semantics, the
  regeneration cadence) is 26.5.
- **The 26.4 hot-path optimisations themselves** — 26.3 produces the findings
  (the committed baseline); acting on them (no speculative work) is 26.4.
- **Write/network-command profiling** — the read-only registry (DC-2 rec.)
  excludes `commit`/`add`/`clone`/`fetch`/`push`/`merge`; a fresh-repo-per-iter
  harness for them is a separable design, flagged as a possible follow-up, not
  folded in.
- **Memory/allocation profiling per command** — 26.6 already ships a narrow
  RSS/heap probe for the two memory-pressure workloads (`bench-memory.ts`); a
  general per-command allocation harness is not part of 26.3 (CPU/timing is the
  26.3 signal) and would be its own item if wanted.
- **Merging the profile baseline into `bench-summarize.ts` / the snapshot /
  `gh-pages` pipeline** — the committed baseline is its own artifact (DC-1),
  kept separate from the non-committed timing summary and the `gh-pages` trend
  history, mirroring 26.6's separation of `memory.*` from `summary.md`.
- **Competitor comparison (26.7)** — the per-command numbers feed it later; the
  head-to-head writeup is 26.7.
