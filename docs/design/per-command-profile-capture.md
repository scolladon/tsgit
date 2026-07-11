# Design — Per-command profile capture (`npm run profile <cmd>`); commit baseline

> Brief: Extend `npm run profile` from its three hardcoded hot paths
> (`log`/`status`/`pack-read`) to profile *any single command by name* —
> `npm run profile <cmd>` — and commit a **portable** per-command performance
> baseline that the findings-driven hot-path work (26.4) and the CI regression
> gate (26.5) build on.
> Status: draft → self-reviewed ×3 → decision candidates opened → **ADR
> conversation settled**. The load-bearing choices are ratified in **ADR-475**
> (committed baseline = normalised hot-function self-shares in `docs/perf/`),
> **ADR-476** (registry = read-only **plus one-shot write** commands — the
> deviation from this doc's original read-only-only recommendation), and
> **ADR-477** (extend `tooling/profile.ts` in place; tooling-only). This
> revision folds those decisions into the design body; the "Decision candidates"
> section now records each as ratified, and adds the write-command harness detail
> ADR-476 requires before planning.

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

The surface this change extends. Its shape (current symbol name-paths, all to be
touched by this item):

- **Parent/child split.** Parent mode iterates a hardcoded
  `HOT_PATHS = ['log', 'status', 'pack-read']` triple; for each, `captureProfile`
  spawns a `node --prof` child via `spawnToCompletion` (`--child <path>`) in an
  `os.tmpdir()` `mkdtemp` work dir, post-processes the emitted `isolate-*.log`
  with `processProfile` (`node --prof-process`), and writes the digest to
  `reports/profiles/<path>.txt` (`PROFILE_DIR`).
- **Child mode** (`runChild(hotPath)`) opens the cached **medium** fixture
  (`ensureScaledFixture(MEDIUM_FIXTURE)`) and loops the one operation
  `CHILD_ITERATIONS = 100` times under the profiler. `log`/`status` re-run on a
  shared `openRepository` repo; `pack-read` re-opens a fresh repo per iteration
  and calls `fresh.primitives.readBlob(fixture.firstBlobId)`, disposing each.
- **`dist/`-import pattern.** `openRepository` is dynamically imported from
  `DIST_ENTRY = dist/esm/index.node.js` via `pathToFileURL` — a strip-only
  runtime (`--experimental-strip-types`) cannot resolve `src/**`'s `.js`-suffixed
  specifiers to their `.ts` siblings nor parse `TsgitError`'s parameter-property
  constructor (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). Hence the `profile` npm
  script is `npm run build && node --experimental-strip-types tooling/profile.ts`.
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
  It also owns the canonical **env-isolation idiom** the profiler must reuse:
  `gitEnv()` returns `process.env` with every `GIT_*` key stripped (a husky hook
  or a parent `git` can export `GIT_DIR`/`GIT_WORK_TREE`, which take precedence
  over `-C <dir>`), and `runGit`/`runFastImport` spawn `git` with that scrubbed
  env. (Note: `gitEnv()` scrubs but does *not* itself set `GIT_CONFIG_NOSYSTEM`
  or pin dates — the fixture pins dates inline in the fast-import stream; the
  bench preambles below add `GIT_CONFIG_NOSYSTEM=1` + pinned author/committer
  identity/date on top of the scrub, which is the fuller idiom the new
  `git`-spawning surfaces here must copy.)
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
- **`test/bench/clone-small-repo.bench.ts`** — the **one-shot / fresh-dir-per-iter
  precedent** the write-command harness copies. Each iteration `mkdtemp`s a fresh
  target dir and pushes it to a `tmpdirs[]` array; **all** dirs are `rm`'d in
  bulk in an `afterAll` "so cleanup time does not enter the sampled distribution",
  and the `http.Server` boots once (not per iter — "per-iter server boot would
  dominate the measurement"). This is exactly the setup-pollution shape ADR-476
  names, solved by keeping teardown off the sampled path.
- **`test/bench/describe.bench.ts` / `name-rev.bench.ts`** — the **read-command
  preamble precedent**. `describe` needs a tag ten commits below HEAD
  (`ensureNearTag`: `git tag -f -a <name> HEAD~10`); `name-rev` needs a tagged
  dangling commit dated a day past the tip (`ensurePrunableTaggedTip`:
  `git commit-tree` + `git tag -f -a` with pinned dates). Both build their
  `benchEnv()` by scrubbing `GIT_*` then re-adding
  `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` =
  `bench` / `bench@tsgit.invalid` and `GIT_CONFIG_NOSYSTEM=1`, plus
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` when a deterministic oid is needed.
  Both use `tag -f` / deterministic `commit-tree` so the **shared, cache-keyed
  fixture never grows or moves a branch** — idempotent by construction.
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
  pre-warms a cache; its unknown-arg → usage-message → `exit 1` idiom is the one
  the profiler's unknown-`<cmd>` path mirrors.

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
  `!reports/api.json`. ADR-475 places the committed baseline **outside**
  `reports/` (`docs/perf/`), so **no `.gitignore` change is needed** — the
  `docs/` tree is fully tracked.
- **CLAUDE.md — structured output (ADR-249)** and **git-faithfulness (ADR-226)**:
  both bind the *library*. This item is **tooling-only** (ADR-477 confirms it):
  the profiler consumes the existing structured `openRepository` API; it adds
  **no** command-surface option and asserts **no** git-observable behaviour. So
  no faithfulness matrix is pinned here. The one empirical pin below is a
  *tooling-behaviour* pin (what `node --prof-process` emits), not a git-behaviour
  pin.
- **Coverage / mutation**: `vitest.config.ts` coverage `include` is
  `src/{domain,ports,adapters/node,adapters/memory,operators}/**` only —
  `test/bench/**` and **`tooling/**` are never instrumented. So the extended
  `tooling/profile.ts` and any helpers extracted from it carry **no** coverage or
  mutation obligation, exactly as `profile.ts` doesn't today. A pure helper
  extracted under `tooling/` (arg parsing, the digest parser, the baseline
  writer) *may* get an optional `tooling/test/unit` test, but nothing gates it.
- **26.6 sibling precedent** (`design/memory-pressure-bench-scenarios.md`):
  its Part E `bench-memory.ts` sets the pattern this item echoes — a
  standalone tooling script, `dist`-import, fixture-driven, emitting a
  **structured JSON + human markdown** pair as its own artifact, kept separate
  from the timing summary. 26.6 explicitly names "the general 26.3 per-command
  profile harness" as the broader item this is.

## The crux — the empirical pin behind the committed-baseline form

`reports/profiles/*.txt` (V8 CPU digests) and `reports/benchmarks/{summary.md,memory.{json,md},snapshot.json}` are all **git-ignored and host-specific**. Committing any of them raw fails the "portable + diffable" bar. ADR-475 ratifies **what portable form the committed baseline takes and where it lives** — normalised hot-function self-shares in `docs/perf/`. This section pins the evidence the ADR rests on; the decision itself is recorded under DC-1 as ratified.

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

Conclusion the crux rests on (ratified as ADR-475): **a committed baseline
cannot be a raw `--prof-process` digest, a raw `bench-summarize` table, or a raw
`snapshot.json` with absolute ms.** It is a *normalised, deterministic,
structured extract* — self-relative hot-function shares — with a machine banner
recorded as metadata, not as the compared value, committed to `docs/perf/`.

> Isolation note: the pin above wrote only inside `mktemp -d`; nothing touched
> the worktree's `.git/config`, any global config, or `reports/`.

## Requirements

When this ships:

1. `npm run profile <cmd>` profiles a **single named command** against the
   scaled fixture, replacing the hardcoded triple's *only* entry points with a
   name→workload resolution. The bare `npm run profile` (no arg) profiles the
   whole registry (ADR-476).
2. The profilable-command set is **explicit and documented** — an unknown or
   unprofilable `<cmd>` fails fast with a clear message listing the valid set,
   never silently no-ops (ADR-476).
3. A **portable, in-repo, diffable** per-command baseline is committed as
   normalised hot-function self-shares in `docs/perf/baseline.json` + a sibling
   `docs/perf/baseline.md`, in a form that survives a machine change (shares, not
   absolute), consumable by 26.4 (findings) and 26.5 (±N% gate) (ADR-475).
4. The baseline lives at a path **actually tracked by git** — `docs/perf/`,
   outside `reports/`, needing no `.gitignore` surgery (ADR-475).
5. The profiler reuses the existing fixture / `dist`-import / graceful-degrade
   machinery — **no** duplicated fixture generation, no second copy of the
   strip-only `dist`-import dance (ADR-477).
6. The registry covers **read-only commands *and* one-shot write commands**
   (ADR-476). Read-only commands loop in place; write commands run against a
   **fresh scratch repo built and torn down per iteration**, with the
   command-under-measurement separated from its fresh-repo setup so a write
   command's committed shares are its own, not its setup's.
7. The captured metric per command is **stable enough to commit and diff** under
   a ±N% gate — determinism is asserted in *shape* (frame set + share ordering),
   not in absolute value (ADR-475).
8. **No library surface change.** No command gains a rendering/perf option; the
   profiler drives the existing structured API only (ADR-249/226 unaffected —
   ADR-477).
9. Graceful degrade unchanged: `git` absent → clear message + non-zero exit;
   Stryker sandbox / missing fixture handled as today. The one new
   `git`-spawning surface (the read-command `setup` preamble) is env-isolated
   (scrub `GIT_*`, pinned identity/date, `GIT_CONFIG_NOSYSTEM=1`) and idempotent
   against the shared cache; the write-command scratch factory drives the
   **library** in `mktemp` dirs (identity pinned through the structured API), so
   it isolates by construction and touches nothing shared.

## Design

The sections below describe the **ratified** shape for each area (ADR-475/476/477).
The write-command harness (D2) is the main new design work the deviation
(ADR-476 option 2) requires.

### D1 — Command→workload resolution and arg parsing (ADR-476)

Replace the hardcoded `HOT_PATHS` triple with an **explicit registry** mapping a
profilable command name to a *workload descriptor*. The descriptor distinguishes
the two loop regimes ADR-476 ratifies — in-place read loop vs fresh-scratch-repo
write loop:

```
type ReadWorkload = {
  readonly kind: 'read';
  readonly fixture: FixtureSpec;                          // which scaled fixture to open
  readonly setup?: (fixtureCwd: string) => Promise<unknown>; // env-isolated, idempotent
                                                          // preamble → resolved target
  readonly run: (repo, fixture, target) => Promise<void>; // one representative unit, looped in place
  readonly perIterationRepo?: boolean;                    // re-open per iter (cold-read paths, e.g. pack-read)
  readonly iterations?: number;                           // override CHILD_ITERATIONS for slow cmds
};

type WriteWorkload = {
  readonly kind: 'write';
  readonly build: (env) => Promise<ScratchRepo>;          // fresh repo per iteration (see D2)
  readonly run: (repo, scratch) => Promise<void>;         // the command under measurement
  readonly iterations?: number;                           // write iters are heavier → smaller default
};

type ProfileWorkload = ReadWorkload | WriteWorkload;
const WORKLOADS: Record<string, ProfileWorkload> = { log, status, 'pack-read', commit, add, merge, … };
```

- **Read-only members** (`kind: 'read'`): `log`, `status`, `pack-read` (today's
  three — `pack-read` names the cold `readBlob` regime, `perIterationRepo: true`,
  a fresh-repo-per-iteration read of `fixture.firstBlobId`) plus the read commands
  the bench suite already covers — `describe`, `name-rev`, `blame`, `diff`,
  `show`, `cat-file`, `rev-parse`. Facade calls: `repo.log()`, `repo.status()`,
  `fresh.primitives.readBlob(id)`, `repo.describe(rev?)`, `repo.nameRev(rev)`,
  `repo.blame(path)`, `repo.diff({...})`, `repo.show(rev)`, `repo.catFile({...})`,
  `repo.revParse(expr)`. All are idempotent-loopable against the shared fixture.
- **Write members** (`kind: 'write'`): the initial set and its rationale is in
  **D2 §"Which write commands ship"**.
- **Arg parsing**: `process.argv` after `--child` stays the child-mode marker;
  the parent reads `process.argv[2]` as `<cmd>`. Unknown `<cmd>` → print
  `usage: profile <cmd> (one of: …)` + `process.exit(1)` (mirrors
  `gen-bench-fixture.ts`'s exact idiom). No arg → profile the whole registry.
- **Read-command preamble.** The raw medium fixture is a plain linear history
  with one `main` ref and **no tags**, so several read commands cannot be
  profiled by a bare call: `describe`/`name-rev` need a tag/target. A
  `ReadWorkload.setup(fixtureCwd)` supplies it, reusing the bench preambles
  verbatim in intent — `describe` → `git tag -f -a <name> HEAD~10`; `name-rev` →
  `git commit-tree` + `git tag -f -a` with pinned dates (returning the target
  oid). Two obligations the planner must honour (ratified by ADR-476/477):
  (1) any preamble that spawns `git` is a **new git-invocation surface** and MUST
  be env-isolated exactly as `benchEnv()` is (scrub `GIT_*`, pin
  author/committer identity + date, `GIT_CONFIG_NOSYSTEM=1`); (2) preambles
  mutate the **shared, cache-keyed** fixture, so they MUST be **idempotent**
  (`tag -f` / deterministic `commit-tree` so the cache never grows or moves a
  branch). A read command with no clean idempotent preamble against the medium
  fixture is **omitted** from the registry, not half-supported.
- **Per-command iteration count.** `CHILD_ITERATIONS = 100` is fine for
  `log`/`status`; a slow read (e.g. `blame` over a 5k-commit file) or any write
  command at 100 iters under `--prof` may be impractically slow, and each write
  iteration additionally pays a full scratch-repo build+teardown. The descriptor
  carries an optional `iterations` override; the read default stays 100, and
  write commands use a **smaller default** (see D2). This keeps a single knob per
  workload rather than a magic constant.

### D2 — The write-command harness (the ADR-476 deviation — main new work)

ADR-476 option 2 adds one-shot write commands to the registry. A write command
cannot loop in place — each `commit`/`add`/`merge` mutates repo state — so each
iteration runs against a **fresh scratch repo** built and torn down per
iteration. Two problems this section solves concretely: (a) how the scratch repo
is built + disposed reusing existing machinery, not reinvented; (b) how the
command's own hot shares are separated from the per-iteration setup frames that
sit on the sampled path (the pollution ADR-476 names).

#### The scratch-repo factory

A new small pure helper module under `tooling/` (e.g.
`tooling/profile-scratch-repo.ts`) exposes a factory that builds a minimal,
deterministic working-tree repo in an `os.tmpdir()` `mkdtemp` dir and returns a
handle for teardown:

```
type ScratchRepo = { readonly cwd: string; readonly repo: Repository; dispose(): Promise<void> };

// env is the scrubbed+pinned NodeJS.ProcessEnv (see §env-isolation)
buildCommitScratch(env): Promise<ScratchRepo>   // init + one staged file, ready for `commit`
buildAddScratch(env):    Promise<ScratchRepo>   // init + N unstaged working-tree files, ready for `add`
buildMergeScratch(env):  Promise<ScratchRepo>   // init + two divergent branches, ready for `merge.run`
```

Reused machinery (no reinvention):

- **Directory + teardown** copy `clone-small-repo.bench.ts`: `mkdtemp` under
  `os.tmpdir()` for the cwd; `dispose()` closes the repo (`repo.dispose()`) and
  `rm(cwd, { recursive: true, force: true })`. The profiler already imports
  `mkdtemp`/`rm` from `node:fs/promises` — no new dependency.
- **Repo construction via the library's own structured API** (the `dist`-import,
  `openRepository`, unchanged from ADR-477): `openRepository({ cwd })` →
  `repo.init()` (the exact fresh-repo idiom `add-add-content-interop.test.ts`
  uses), then the descriptor's preamble stages/branches as needed. Working-tree
  files are written with `writeFile` from `node:fs/promises`. Facade write
  shapes the `run` closures call:
  - `commit` → `repo.commit({ message, author, committer })` (identity pinned;
    see below). Requires a working tree (`assertNotBare`) and a staged index —
    `buildCommitScratch` stages one file first.
  - `add` → `repo.add(paths, { all: true })` or literal `paths` — `buildAddScratch`
    writes the working-tree files the call will stage.
  - `merge` → `repo.merge.run({ rev, fastForward: 'never' })` — `buildMergeScratch`
    creates two branches that diverge by one commit each so `merge.run` performs
    a real (non-fast-forward) three-way merge, the representative shape.
- **`git` is NOT spawned to build the scratch repo** — the library's own
  `init`/`add`/`commit` build it, because (i) that is the code path 26.4 wants to
  profile anyway and (ii) it keeps the scratch build inside the `dist`-import the
  tool already uses. `git` remains spawned only in the read-command preamble
  (D1). This narrows the net-new `git`-invocation surface to the read preambles;
  the write factory adds **no** new `git`-spawn surface, only new
  library-API-driven filesystem writes in `mkdtemp` dirs.

The scratch fixtures are **tiny and fixed** (a handful of small files, two
one-commit branches) — deliberately *not* scaled: a write command's hot shares
(index write, tree write, object write, merge diff3) are exercised by a small
deterministic repo, and a large scratch would make per-iteration build cost
dominate. This is the same reasoning `clone-small-repo` uses (a 5-commit source),
not the 5k-commit `MEDIUM_FIXTURE`.

#### The measurement-pollution mechanism (ratified concretely here)

ADR-476 requires that a write command's own hot shares be separated from its
per-iteration setup frames. **Chosen mechanism: measure only the command
closure, keep setup and teardown off the sampled path, and additionally filter
setup frames in the digest parser.** Concretely, three layers, in priority
order:

1. **Structural — the sampled loop calls only the command.** The child-mode
   write loop is:
   ```
   const scratches: ScratchRepo[] = [];
   for (let i = 0; i < iterations; i += 1) {
     const scratch = await workload.build(env);   // setup — see below re: sampling
     scratches.push(scratch);                      // defer dispose out of the loop body
     await workload.run(scratch.repo, scratch);    // ← the ONLY line we care to measure
   }
   // teardown after the loop, off any meaningful sample tail
   for (const s of scratches) await s.dispose();
   ```
   Teardown is deferred to after the loop exactly as `clone-small-repo` defers
   `rm` to `afterAll` — so `dispose`/`rm` (which are themselves library/`fs`
   frames that would otherwise pollute the sample) never enter the measured
   region. Deferring accumulates `iterations` live scratch handles; this is
   bounded because write workloads use a **small `iterations` default** (D1) and
   each scratch is tiny (a handful of small files) — the accumulation is a few
   dozen `mkdtemp` dirs, not a leak. The per-iteration `build` is *inside* the
   loop (it must be — a fresh repo per iter), so its frames *do* land in the
   profile; layers 2–3 handle that.
2. **Warm-up iterations.** The write loop runs a small fixed number of
   **untracked warm-up iterations** before the measured ones are meaningful —
   but since `--prof` samples the whole child process, warm-up alone cannot
   exclude setup. Warm-up is retained only to stabilise JIT tiering (the first
   few `commit`s are cold); it is *not* the pollution fix on its own.
3. **Setup-frame attribution in the digest parser (the real separator).** The
   digest parser (D3) already filters to *tsgit's own* frames off the
   shared-library/unaccounted noise floor. For write commands it additionally
   **partitions tsgit frames into `setup` vs `command`** using a small, explicit
   **setup-frame denylist** keyed on the primitive functions the scratch build
   calls (`init`, index-write, blob-write, `writeTree`, the `add`/first-`commit`
   path) — frames reached *only* through `build`, never through the command
   under measurement. The committed baseline records the **command partition** as
   `hotShares` and the **setup partition** as a sibling `setupShares` block, so:
   - the hot-path work (26.4) reads a **clean command signal** (setup frames are
     quarantined, not silently mixed in);
   - the setup contribution is **documented, not hidden** — ADR-476 explicitly
     wants "the baseline documents which frames are setup vs the command proper".

   Where a frame is genuinely shared (e.g. `writeObject` is used by both the
   commit under test *and* the scratch build), it is attributed to `command`
   (the conservative choice: never *under*-report the command's cost) and the
   baseline markdown notes the shared frames per write command. The denylist is
   a small named constant in the parser helper, reviewed like any other, not a
   heuristic.

This is the least-magic option: it does not try to make `--prof` sample only a
sub-region (impossible — it samples the process), it does not fabricate a
setup-subtracted number, and it keeps the raw shares honest while giving 26.4 a
clean per-command view. The alternative of "documenting the setup contribution
in the baseline only" (no parser partition) was considered and rejected as
insufficient — it leaves 26.4 to eyeball which top frames are setup, which is
exactly the ambiguity ADR-476 asked to remove.

#### Which write commands ship (and which are omitted)

Initial write registry — commands with a **clean, deterministic, representative
one-shot form** against a tiny scratch repo:

- **`commit`** — `buildCommitScratch` stages one small file; `run` calls
  `repo.commit({ message, … })`. Representative: index-read, tree-write,
  commit-object-write, ref update. Deterministic (pinned identity + message).
- **`add`** — `buildAddScratch` writes a fixed set of small working-tree files;
  `run` calls `repo.add(paths, { all: true })`. Representative: working-tree
  walk, hash, index write. Deterministic.
- **`merge`** — `buildMergeScratch` builds two branches diverging by one commit
  each (disjoint file edits → clean three-way merge, no conflict); `run` calls
  `repo.merge.run({ rev, fastForward: 'never' })`. Representative: merge-base,
  three-way tree merge, merge-commit write. Deterministic (pinned identities +
  dates make the branch oids stable).

**Omitted from the initial registry, with reasons:**

- **`clone` / `fetch` / `push`** — need a live remote / network; not
  deterministically loopable. ADR-476 keeps them out (they belong to the
  `clone-small-repo` bench's server-backed shape, not this CPU-share harness).
- **`checkout` / `reset` / `stash` / `rebase` / `cherry-pick` / `revert`** — each
  has a representative one-shot form in principle, but each needs a bespoke
  scratch shape (a populated working tree, a stack of commits to replay) whose
  setup cost and setup-frame footprint are larger than `commit`/`add`/`merge`.
  They are **deferrable**: adding one later is a registry edit + one
  `build<Cmd>Scratch` helper + a denylist extension — the harness is built to
  take them, but the initial three (`commit`/`add`/`merge`) are the smallest set
  that proves the write path and covers the write hot-shares 26.4 is most likely
  to touch first. Per the repo's "no silent follow-ups" default, this omission is
  called out here for the ADR/planning conversation rather than filed away.

#### Env-isolation obligation for the new surfaces

Every `git` the profiler spawns (read-command preambles only, per the factory
note above) and every library-driven write the scratch factory makes runs under
the **scrubbed+pinned env** the bench preambles use — assembled once as a
`profileEnv()` helper mirroring `name-rev.bench.ts`'s `benchEnv()`:

- start from `process.env` with every `GIT_*` key stripped (the `gitEnv()` scrub —
  a husky hook or parent `git` can export `GIT_DIR`/`GIT_WORK_TREE`, which
  override `-C <dir>` and would redirect subprocesses to the wrong repo);
- re-add pinned identity: `GIT_AUTHOR_NAME`/`GIT_COMMITTER_NAME = profile`,
  `GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_EMAIL = profile@tsgit.invalid`;
- re-add pinned dates (`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`) wherever a
  deterministic oid is required (the `name-rev` preamble target; the merge
  scratch's branch commits) so builds are byte-stable across runs;
- set `GIT_CONFIG_NOSYSTEM=1` so no host `/etc/gitconfig` leaks in.

For the library-driven scratch writes (`repo.init`/`add`/`commit`/`merge.run`),
the pinned identity is passed **through the structured API** (the `author`/
`committer` options on `commit`/`merge.run`) rather than only via env, since the
library resolves identity from config/options, not just `GIT_*`. Env pinning
still applies for the read preambles' `git` spawns. Idempotency: read preambles
never grow the shared cache (`tag -f` / deterministic `commit-tree`); write
scratches live in `mktemp` dirs and are `rm`'d, touching nothing shared.

### D3 — What is captured and its determinism (ADR-475)

The committed baseline is **CPU hot-function self-shares** — from the existing
`--prof` / `--prof-process` path, **parsed** into a structured `{ frame → self% }`
map filtered to *tsgit's own* frames (drop Shared-libraries / Unaccounted /
node-internal noise per the empirical pin), self-normalised so the shares sum
over the tsgit surface. Deterministic *in rank/share* across machines even though
absolute ticks are not (that is exactly why shares, not ticks). Absolute
ticks/ms are deliberately excluded (non-portable per the pin); timing stays in
the existing non-committed nightly/snapshot pipeline.

The digest parser is the one new parsing surface. It reads the `--prof-process`
bottom-up / summary sections, keeps tsgit frames, drops the noise floor, and — for
write workloads — partitions into `command` vs `setup` per the D2 denylist. A
trivially fast command whose digest shows no tsgit frame above the noise floor
records an empty/short `hotShares` **with a warning**, never fabricated shares —
a signal the command may not belong in the registry (ADR-475 consequence).

### D4 — Where the tool lives (ADR-477)

**Extend `tooling/profile.ts` in place.** It already owns the
`--prof`/`--prof-process` capture (`captureProfile`, `processProfile`,
`spawnToCompletion`), the parent/child spawn, the `dist`-import (`DIST_ENTRY`),
and the fixture graceful-degrade. The per-command generalisation is a **registry
swap + a digest parser + a baseline writer + the scratch factory** — not a new
machine. Per ADR-477's many-small-files note, the substantial additions are
extracted into small sibling modules under `tooling/`:

- `tooling/profile-registry.ts` — the `WORKLOADS` map + descriptor types + arg
  resolution (unknown-`<cmd>` → usage).
- `tooling/profile-digest.ts` — the `--prof-process` parser (tsgit-frame filter,
  self-normalisation, write-command `command`/`setup` partition + denylist).
- `tooling/profile-scratch-repo.ts` — the write-command scratch factory
  (`build*Scratch`, `ScratchRepo`, `dispose`).
- `tooling/profile-baseline.ts` — the `docs/perf/baseline.{json,md}` writer.
- `tooling/profile-env.ts` — `profileEnv()` (scrub+pin).

`profile.ts` stays the entry point orchestrating them; the `npm run profile`
script is unchanged in shape (`npm run build && node --experimental-strip-types
tooling/profile.ts [<cmd>]`). It is **not** folded into `bench-summarize.ts`
(that keys on `tsgit`/`isomorphic-git` bench names and only knows wall-clock ms;
CPU hot-shares are a different signal — the 26.6 precedent kept `bench-memory.ts`
separate for exactly this reason). Fixture reuse: `ensureScaledFixture` + the
`FixtureSpec` values are imported unchanged; no fixture generation is duplicated.

### D5 — Where the committed baseline lives and its shape (ADR-475)

The committed artifact is a **structured JSON** (`docs/perf/baseline.json`,
machine-diffable) with a sibling human-readable markdown
(`docs/perf/baseline.md`), mirroring the 26.6 `memory.{json,md}` pair — but
committed **outside `reports/`** so it needs no `.gitignore` surgery and reads as
a deliberate, reviewed artifact. Shape:

```
{
  "generatedOn": "<platform-arch> / node vX / <CPU>",   // metadata, NOT compared
  "commands": {
    "log":    { "hotShares": [ { "frame": "walkCommitsByDate", "self": 0.41 }, … ] },
    "status": { "hotShares": [ … ] },
    "commit": {
      "hotShares":   [ { "frame": "writeCommitObject", "self": 0.33 }, … ],  // command partition
      "setupShares": [ { "frame": "init",              "self": 0.12 }, … ]   // fresh-repo build, documented
    }, …
  }
}
```

Read commands carry `hotShares` only; write commands additionally carry
`setupShares` (the per-iteration fresh-repo build partition — documented, never
mixed into `hotShares`). Absolute ticks/ms are excluded. 26.5 diffs `self`
shares per frame within a ±N% band; 26.4 reads the top `hotShares` frames as its
optimisation targets and ignores `setupShares`.

### D6 — Wiring into 26.4 and 26.5

- **26.4 (findings-driven hot-path work)** consumes the committed per-command
  `hotShares` directly: "the baseline says frame X is N% of command Y" is the
  *only* license 26.4 has to touch a hot path (no speculative work). For write
  commands it reads the `command` partition (`hotShares`), never `setupShares`.
  Regenerating one command's slice via `npm run profile <cmd>` after a change
  confirms the share moved. No new wiring — 26.4 reads the committed JSON.
- **26.5 (CI regression gate)** diffs a fresh capture against the committed
  baseline, failing when any scenario's tracked metric exceeds ±N%. The gate
  script and threshold are **26.5's** to design; 26.3 only guarantees the
  baseline is (a) committed in-tree (`docs/perf/`), (b) in a diffable structured
  shape, (c) normalised so a CI machine's capture is comparable to the committed
  one. The gate keys on `hotShares` (per ADR-475).
- **CI regeneration cadence** is out of scope here (26.5 decides whether the
  gate regenerates on a fixed runner or compares committed-vs-fresh); 26.3 only
  produces the artifact and the `npm run profile <cmd>` regeneration path.

### Error semantics / edge behaviour

- **Unknown `<cmd>`** → `usage: profile <cmd> (one of: …)` + exit 1 (no silent
  no-op; mirrors `gen-bench-fixture.ts`).
- **`git` absent / fixture unavailable** → the existing `ensureScaledFixture`
  try/catch prints "install the `git` CLI and retry" + exit 1. The up-front
  fixture guard in `main()` must fire **only when a read workload in scope needs
  the scaled fixture** (today it fires unconditionally because all three legacy
  paths are read paths). Write workloads build their own tiny scratch repo via
  the **library** in a `mkdtemp` dir — they touch neither `ensureScaledFixture`
  nor `git`, so a run selecting only write command(s) must not hard-fail on an
  absent `git`/fixture; a `mkdtemp`/`rm` failure surfaces loud, never swallowed.
  The read-command `setup` preambles *do* spawn `git` — those workloads still
  require the CLI, and a mixed no-arg run degrades exactly as today when the
  fixture is unavailable (the read slice cannot run).
- **Stryker sandbox** (`STRYKER_MUTANT_ID`) → not applicable; tooling is not
  mutated. No behaviour needed.
- **A profilable command that throws** under the profiler → the error surfaces
  loud (spawn non-zero close / rejected promise), never swallowed — as today.
  A write scratch that fails to build fails the iteration loudly; partially-built
  scratch dirs are still `rm`'d in the deferred teardown.
- **Digest with no tsgit frames above the noise floor** → the parser records an
  empty/short `hotShares` with a warning, rather than fabricating shares (ADR-475).

## Decision candidates

Every load-bearing choice is recorded below. **DC-1, DC-3, DC-4, DC-5 are
ratified** by ADRs 475/477 as originally recommended; **DC-2 is ratified as the
deviation** (ADR-476 option 2, broader than this doc first recommended). No fork
below is open. One genuinely-new sub-choice surfaced by the write-command design
is recorded as DC-6, with a recommendation, for the planning conversation.

### DC-1 — Committed-baseline form & location (the crux) — **RATIFIED (ADR-475)**

**Question:** What portable form does the committed per-command baseline take,
and where does it live, given raw digests/summaries are host-specific and
git-ignored?

- **(a) Structured JSON of normalised hot-function self-shares + metadata banner,
  committed outside `reports/`** (`docs/perf/baseline.json` + sibling markdown).
- (b) Reuse/extend `bench:summary`'s output in a normalised (ratio) form under a
  new `!reports/…` `.gitignore` exception.
- (c) Self-relative hot-function shares (%) only, narrowest portable artifact.

**Ratified: (a)** (ADR-475, adopted as the design recommended). Shares are the
portable signal the empirical pin identified and are exactly what 26.4 consumes;
`docs/perf/` avoids `.gitignore` surgery and signals intent. The write-command
partition (`setupShares` alongside `hotShares`) refines (a) without changing its
form.

### DC-2 — `profile <cmd>` command selection & no-arg behaviour — **RATIFIED as the deviation (ADR-476)**

**Question:** Which commands are profilable, how does `<cmd>` resolve to a
workload, and what does `npm run profile` (no arg) / an unknown `<cmd>` do?

- (a) Read-only registry only — write/network excluded.
- **(b) Read-only registry + one-shot write commands** (`commit`, `add`,
  `merge`, …) via a fresh-repo-per-iteration scratch factory + teardown; broader
  coverage at the cost of a more complex harness whose per-iteration setup is on
  the sampled path.
- (c) Keep the legacy triple as the no-arg default; `<cmd>` opts into a wider set.

**Ratified: (b)** (ADR-476 — user-chosen, **over this doc's original (a)
recommendation**, so the hot-path work can baseline write paths, not just read
paths). This drove the design revision: the write-command harness (D2) — scratch
factory, deferred teardown, setup-frame partition — is the concrete realisation
of (b). No-arg profiles the whole registry (read + write); `<cmd>` narrows to
one; unknown/unprofilable → usage + exit 1.

### DC-3 — Where the tool lives — **RATIFIED (ADR-477)**

**Question:** Is per-command profile capture a new tool, an extension of
`profile.ts`, or folded into `bench-summarize.ts`?

- **(a) Extend `tooling/profile.ts` in place** (registry swap + digest parser +
  baseline writer + scratch factory; substantial additions extracted into small
  sibling `tooling/` modules).
- (b) New `tooling/profile-baseline.ts` alongside — duplicates the spawn /
  `dist`-import / fixture scaffolding.
- (c) Fold into `bench-summarize.ts` — rejected (wall-clock-only, keys on
  `tsgit`/`isomorphic-git` names).

**Ratified: (a)** (ADR-477, adopted as recommended). Smallest surface, zero
duplication, reuses every proven idiom; the many-small-files extraction (D4) is
the natural refinement, still within (a).

### DC-4 — Metric captured & its determinism — **RATIFIED (ADR-475)**

**Question:** What does the committed baseline measure, and what makes it stable
to commit and diff under a ±N% gate?

- **(a) CPU hot-function self-shares** — parsed from `--prof-process`, filtered
  to tsgit frames, self-normalised. Machine-portable (shares, not ticks).
- (b) Normalised wall-clock ratio — coarser, carries ±20% runner variance.
- (c) Both — doubles the artifact and the gate's metric choice.

**Ratified: (a)** (ADR-475, adopted as recommended), with the machine banner as
metadata. Most machine-portable signal; precisely the "findings" 26.4 acts on.
Determinism is asserted in *shape* (frame set + share ordering), not absolute
value.

### DC-5 — Faithfulness / structured-output (ADR-249/226) confirmation — **RATIFIED (ADR-477)**

**Question:** Does any part of this touch the library's command surface or
git-observable behaviour?

- **(a) Confirm tooling-only** — no command gains a rendering/perf option; the
  profiler consumes the existing structured `openRepository` API; no git
  behaviour is asserted, so no faithfulness matrix / interop test is pinned.

**Ratified: (a)** (ADR-477). ADR-249/226 confirmed unaffected. The only
`git`-invocation surface is the read-command `setup` preamble (the write scratch
factory drives the **library**, not `git`), carrying an **env-isolation**
obligation (scrub `GIT_*`, pinned identity/date, `GIT_CONFIG_NOSYSTEM=1`,
idempotent against the shared cache) — not a faithfulness pin; it asserts no git
output.

### DC-6 — Write-command setup/command frame separation mechanism — **NEW; recommendation below**

**Question:** ADR-476 states write-command baselines "name the setup contribution
explicitly (via the frame filter and/or a documented caveat) so the setup frames
are not mistaken for the command's own hot shares", but does not fix *which*
mechanism. `--prof` samples the whole child process, so per-iteration
fresh-repo setup frames land in the digest; how are they separated from the
command's own shares in the committed baseline?

- **(a) Parser partition via an explicit setup-frame denylist + a `setupShares`
  block in the artifact.** The digest parser splits tsgit frames into `command`
  vs `setup` using a small named denylist of the primitives the scratch build
  calls (`init`, index/blob/tree write on the build path); shared frames
  attributed to `command` (never under-report the command). 26.4 reads
  `hotShares` (command); `setupShares` is committed and documented. *(design
  recommendation — realised in D2/D3/D5)*
- (b) Documented caveat only — commit the raw combined `hotShares` and note in
  the markdown which top frames are setup. Simplest, but leaves 26.4 to eyeball
  the split — exactly the ambiguity ADR-476 asked to remove.
- (c) Separate setup-only calibration pass — run the scratch build *without* the
  command under `--prof`, subtract its shares from the combined run. Most
  "accurate" in principle, but subtraction across two noisy low-sample runs is
  not stable (the pin: absolute ticks vary run-to-run), and it fabricates a
  derived number rather than reporting honest shares.

**Recommendation: (a).** It is the least-magic option that satisfies ADR-476's
"documents which frames are setup vs the command proper": no attempt to make
`--prof` sample a sub-region (impossible), no fabricated subtraction (c), and it
keeps the raw shares honest while giving 26.4 a clean command view (b's gap).
The denylist is a small reviewed constant in `tooling/profile-digest.ts`, not a
heuristic; shared frames resolve conservatively to `command`. This is un-settled
by ADR-476's text (which named the *goal*, not the *mechanism*), so it is
surfaced here for the planner rather than decided unilaterally.

## Test / faithfulness plan

- **No faithfulness matrix, no interop test.** This item asserts no
  git-observable behaviour (it measures tsgit's own CPU profile) — per the
  faithfulness stance, only behaviour-asserting changes get an interop pin.
  ADR-249/226 confirmed unaffected (ADR-477 / DC-5).
- **Env-isolation of every new `git`/write surface** (DC-2/DC-5). The
  read-command `setup(fixtureCwd)` preamble that spawns `git` (as
  `describe`/`name-rev` require) MUST scrub `GIT_*`, pin author/committer
  identity + date, and set `GIT_CONFIG_NOSYSTEM=1` via the shared `profileEnv()`
  helper, exactly as `describe.bench.ts` / `name-rev.bench.ts` do, and be
  **idempotent** against the shared cache-keyed fixture (`tag -f` / deterministic
  `commit-tree` — never grow or corrupt the cache). The write-command scratch
  factory drives the **library** (`repo.init/add/commit/merge.run`) in
  `mktemp` dirs with pinned identity passed through the structured API (and
  `profileEnv()` for parity), touching nothing shared; teardown `rm`s the
  `mktemp` dir. These are isolation obligations, not faithfulness pins (no git
  output is asserted).
- **Coverage / mutation: none mandated.** `tooling/**` is outside the coverage
  `include`, exactly as `profile.ts` is today, so the extracted helpers
  (`profile-registry`, `profile-digest`, `profile-scratch-repo`,
  `profile-baseline`, `profile-env`) carry no gate. If the digest parser or arg
  resolver is worth an *optional* `tooling/test/unit` test, it is welcome (e.g.
  "given this fixed `--prof-process` digest text, the parser yields these
  tsgit-frame shares and partitions setup vs command per the denylist"; "given
  `<cmd>=foo`, the resolver rejects with the usage message") — but nothing gates
  it, and profile numbers themselves are host-specific artefacts, not assertable
  SUTs.
- **The tool is verified by running it**, not by an assertion: `npm run profile`
  profiles the full registry (read + write) and writes the committed baseline;
  `npm run profile <cmd>` narrows to one and regenerates that slice; an unknown
  `<cmd>` prints the usage list + exits non-zero; `git` absent degrades with the
  clear message + exit 1. Confirm the committed baseline is deterministic in
  *shape* (frame set + share ordering, and the `command`/`setup` partition for
  write commands) across two runs on the same machine, and that its committed
  path (`docs/perf/`) is actually tracked (not swallowed by `.gitignore`).
- **No property tests** — this is I/O + capture + generation tooling; the
  CLAUDE.md property-test lenses (round-trip / matcher / total-function /
  idempotence over a grammar) do not fit generation wrappers.
- **State-mutating probes stay in `mktemp`** — the one empirical pin in this doc
  (the `--prof-process` host-specificity check) ran in a `mktemp -d` throwaway;
  no worktree / global-config / `reports/` writes. The write-command scratch
  repos likewise live only in `os.tmpdir()` `mkdtemp` dirs and are `rm`'d.

## Measurement limitations

The committed baseline is a normalised, self-relative signal — read it as a *ranking of
tsgit's own hot functions per command*, not as absolute cost. Known limitations a reader
(and the 26.4 hot-path work) should keep in mind:

- **`<anonymous>` is an aggregate bucket.** The names-preserved build is still a single
  bundle, so distinct arrow/closure functions with no bound name collapse to one
  `<anonymous>` frame. It can dominate a command's shares (e.g. `pack-read`) without
  pointing at one optimisable function — treat a large `<anonymous>` share as "look
  closer", not a target.
- **Write-command shares are conservatively over-reported for heavy builds.** Each write
  iteration builds a fresh scratch repo inside the sampled loop; frames the build reaches
  *exclusively* (`openRepository`/`init`/`bootstrapRepository`) are quarantined into
  `setupShares`, but frames shared by both the build and the measured command (object /
  tree / commit writes) stay in `hotShares` under the conservative rule (never
  under-report the command). For a command with a heavy build (`merge` runs three build
  commits per iteration) those shared frames are inflated by the build's contribution —
  the shape is right, the magnitude is an upper bound. A per-command setup attribution (or
  a `git`-subprocess scratch build off the sampled process) would tighten this and is a
  possible future refinement.
- **The trivially-fast reads need many iterations.** `rev-parse`/`cat-file`/`describe`/
  `name-rev`/`diff` do sub-millisecond work per call and are looped far more
  (`FAST_READ_ITERATIONS`) so their tsgit tick total clears the noise floor; a command
  that still yields no frame above the floor records empty `hotShares` **with a warning**
  — an honest "not a hot path" signal, not a bug.
- **Most samples are Unaccounted.** A `--prof` capture of any command is dominated by
  Unaccounted + one-time bundle-load ticks (often 85–97 %); the committed baseline is the
  tsgit frames *self-normalised over their own surface*, which is stable in rank across
  machines even though absolute ticks are not. This is exactly why shares — not ticks —
  are committed.

## Out of scope

- **The 26.5 CI regression-gate script + threshold** — 26.3 commits the baseline
  and the `npm run profile <cmd>` regeneration path; the gate that diffs a CI
  capture against it (±N% per scenario, failure semantics, regeneration cadence)
  is 26.5.
- **The 26.4 hot-path optimisations themselves** — 26.3 produces the findings
  (the committed baseline); acting on them (no speculative work) is 26.4.
- **Network-command profiling** (`clone`/`fetch`/`push`) — they need a live
  remote and are not deterministically loopable; ADR-476 keeps them out of this
  registry (they live in the server-backed `clone-small-repo` bench shape).
- **Further write commands** (`checkout`/`reset`/`stash`/`rebase`/
  `cherry-pick`/`revert`) — the harness is built to take them (registry edit +
  one `build<Cmd>Scratch` + denylist extension), but the initial write set is
  `commit`/`add`/`merge` (D2 §"Which write commands ship"). Called out for the
  planning conversation, not silently deferred.
- **Memory/allocation profiling per command** — 26.6 already ships a narrow
  RSS/heap probe (`bench-memory.ts`); a general per-command allocation harness is
  not part of 26.3 (CPU is the 26.3 signal) and would be its own item.
- **Merging the profile baseline into `bench-summarize.ts` / the snapshot /
  `gh-pages` pipeline** — the committed baseline is its own artifact (ADR-475),
  kept separate from the non-committed timing summary and `gh-pages` trend
  history, mirroring 26.6's separation of `memory.*` from `summary.md`.
- **Competitor comparison (26.7)** — the per-command numbers feed it later; the
  head-to-head writeup is 26.7.
