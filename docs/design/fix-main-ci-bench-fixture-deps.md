# Design — fix the two red jobs on `main`: bench fixture mutation + the `check:deps` treadmill

> Brief: `benchmark-snapshot` has been red on `main` since 2026-08-29 because a bench
> mutates the shared cached fixture in place, and `deps` re-reds every day because
> `@cloudflare/workers-types` publishes a date-versioned release daily. Fix the cause of
> each, ship as one chore PR.
> Status: draft → self-reviewed ×3 → revised against ADRs 791–799 → self-reviewed ×2 → D10/D11 settled against amended ADRs 798–799 → review refinements folded (see § Review refinements)

## Review refinements (fold-back after the four-dimension review)

Ten review findings changed mechanisms below. The corrected rule is stated here once; the
part text that still shows the pre-review shape is marked where it matters, and ADRs 791, 793
and 799 carry the amended decisions.

1. **Identity probe by exit code, and an unverifiable cache is kept** (security MEDIUM; ADR-793
   amended). The probe is `symbolic-ref -q HEAD` and `rev-parse --verify -q
   refs/heads/main^{commit}`, run through `probeGit`, which reports the exit code instead of
   rejecting. Exit 1 is git's own answer — detached, or the ref is missing — and is a **proven**
   mismatch; any other non-zero exit (dubious ownership, a spawn that could not start, no git at all) makes the cache
   **unverifiable**: it is handed out unchanged, with a `could not be verified` warning when git
   is present and silently when it is absent (R7, restated). Only a proven mismatch is retired.
   The Part 2 snippet `cacheRejection` and the "chosen over `symbolic-ref -q`" rationale are
   superseded by this rule. Every generator git spawn now runs with an isolated `HOME`,
   `XDG_CONFIG_HOME` and `GIT_CONFIG_NOSYSTEM=1`.
2. **`ensureScaledFixture` is split** (code MEDIUM): `inspectCache` (meta + verdict),
   `trustCached`, `rebuildCache` (re-inspects right before retiring, so a concurrent build's
   pristine winner is reused, never destroyed), `buildIntoCache`, `discardTempBuild` (a cleanup
   failure is logged, never replaces the build error) and `reuseWinnerOrRethrow`. The
   `toScaledFixture` helper and `leftoverDirName(cacheDir, kind, pid, stamp)` are exported.
3. **Leftovers are reclaimed only when their pid is dead, and only for known labels**
   (security MEDIUM; ADR-799 amended). The Part 6 paragraph rejecting a liveness gate is
   superseded: `process.kill(pid, 0)` errs only towards *keeping* (a reused pid keeps a stale
   leftover until the next prune), which is the safe direction, and the shape check alone was
   matching a build in flight. `walkBytes` and the candidate loop run sequentially — the
   fan-out measured 814 MB of pending `lstat`s on a 200 000-file fixture. A candidate that
   vanished between listing and walking is skipped, not reported as a failure. The CLI renders
   through an exported `formatPruneReport` and sets `process.exitCode` rather than exiting.
4. **Scratch copies live beside their fixture** as `<label>-v<N>.scratch.<pid>.<random>`
   (security LOW + perf LOW; ADR-791 amended): same filesystem as every measured fixture, and an
   orphaned copy is a leftover the prune verb can reclaim once its pid is gone. The `slug`
   parameter is gone. A failed `openRepository` disposes the copy before the error propagates.
6. **The HEAD file is read before git is asked** (cycle-2 code MEDIUM). A cache whose `.git`
   is gone or whose `HEAD` holds garbage would otherwise probe as unverifiable forever — kept,
   warned about on every run, failing every bench, and beyond `--prune`'s reach. A pristine
   fixture's `.git/HEAD` is exactly `ref: refs/heads/main`, so anything else is a proven
   mismatch without executing git; only the tip check needs `rev-parse --verify -q`. The
   unverifiable warning now names the directory to delete for a forced rebuild. A mismatch
   proven with no `git` on `PATH` is reported as an unavailable fixture (benches skip) rather
   than handed out — R7, restated once more. `rebuildCache` reuses only a proven-pristine
   winner; an unverifiable one after a proven mismatch is retired.
7. **Git isolation completed** (cycle-2 security): `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`
   at `/dev/null`, and `GIT_CEILING_DIRECTORIES` at the cache root so discovery never walks up
   into an ancestor repository (a `$HOME` dotfiles repo, or `XDG_CACHE_HOME` inside a
   worktree) and answers about the wrong repository.
8. **Cleanup that cannot fail the run** (cycle-2 code/security/tests): `disposeSync` logs a
   removal failure instead of throwing inside tinybench's un-awaited hook; every bench
   teardown in the touched files is synchronous; the CLI never calls `process.exit`. A scenario
   that throws during warmup never reaches its teardown, so `bench.yml` and the
   `benchmark-snapshot` job sweep `*.scratch.*` out of the cache root before the cache
   post-step, unconditionally. The DSL's hook routing (`onMeasuredRun`, `hooksFor`) is unit-
   tested; the prune classifier keeps any leftover whose pid is alive or refused (only the
   kernel's no-such-process answer means dead), and leftovers of an unknown label.
10. **Final cycle** (cycle-3 code/security/tests, applied without a fourth review): a HEAD
   file that exists but cannot be read (permissions, I/O) is unverifiable, not a mismatch —
   only an absent file is a fact; every reason interpolated into a warning is scrubbed to one
   bounded printable line, since a bench can rewrite the file the warning quotes; the inert
   `GIT_CONFIG_SYSTEM` switch is gone (`GIT_CONFIG_NOSYSTEM` already blocks it); every
   synchronous bench cleanup goes through one guarded `removeSync`; the CI sweep covers
   `.tmp.`, `.corrupt.` and `.scratch.` siblings on all three cache-writing jobs; the cache
   root is resolved to an absolute path so the discovery ceiling can never be ignored; the
   decoy repository in the tests is built under the same git isolation as the module. The
   ceiling, the pristine-only winner rule, the read-error split, the scrub, the EPERM branch
   and the guarded remover each gained a discriminating test.
9. **`afterAll` never runs under `vitest bench`** (found by the session's smoke, not by the
   review): `runBenchmarkSuite` calls no suite hooks, so every `afterAll` in `test/bench/**`
   has always been dead — the maintenance copies and every `write-scratch` directory leaked into
   `os.tmpdir()` on every run. `BenchComparison` gains a `teardown` that the bench DSL attaches
   to the scenario's last bench as tinybench's run-phase hook. tinybench 2.9.0 does **not**
   await that hook, so a file's last scenario loses an async removal to the worker's exit (a
   `process.on('exit')` sweep does not run either — the pool kills the worker); the copy is
   therefore removed through `FixtureScratch.disposeSync` first, and the repository handle's
   asynchronous close may float. The user then ruled that the `afterAll` sites in every other
   bench file move to the same channel in this change: 31 cleanup sites across 24 files (30
   teardown hooks — `loose-read.bench.ts`'s module-level and scenario cleanups merge), every
   directory removal synchronous through `removeSync`, handle closes left asynchronous (the
   process exit covers them), the module-level fixture cleanup in `loose-read.bench.ts` folded
   into its last scenario. No `afterAll` remains under `test/bench/`.

## Context

### The brief said "poisoned cache". It is not. The divergence, stated plainly

The original brief diagnosed problem A as a **poisoned
`actions/cache` entry**: a truncated `small` fixture with fewer than 11 commits, restored
forever because the cache key is exact and `readCachedMeta` trusts `meta.version` alone. Its
two proposed fixes were (1) bump `FIXTURE_GENERATOR_VERSION` 3 → 4 to abandon the entry and
(2) validate the restored fixture's **commit count** against `spec.commits`.

The orchestrator's verification addendum falsified that diagnosis, and **the addendum
supersedes the brief**. The cache entry is intact; the mutation happens *inside every run*:

| Brief's claim | What the evidence shows |
|---|---|
| The cached `small` fixture has < 11 commits | It has exactly **50**. `~/.cache/tsgit-bench/small-v3` → `git rev-list --count refs/heads/main` = `50`, `meta.json.headCommitId` = `ca208fa8…` = `rev-parse refs/heads/main` |
| A poisoned entry is restored on every run | The one entry `tsgit-bench-571272fab5…` (created 2026-08-16T19:50:45Z, immutable) was restored and **green** on eight consecutive `main` runs through 2026-08-24, and by the nightly on 2026-08-28 |
| Fix 1 — bump the version constant | The first run regenerates a pristine fixture and `checkout.bench.ts` mutates it **in the same run**; a passing run then saves the *mutated* fixture under the new key |
| Fix 2 — commit-count check | Detects the mutation, then `rename(tmpDir, cacheDir)` throws `ENOTEMPTY` onto the existing dir, the `catch` re-reads the mutated cache and returns it — the run fails identically |

Both brief fixes are therefore set aside as *stated*. Fix 2's **intent** — do not trust a
cached fixture on `meta.version` alone — is kept, with a corrected invariant (§ Part 2).
Fix 1 is a decision candidate, recommended against (D4).

The brief's DO-NOTs stand and are honoured: **no `restore-keys`** on either cache step (a
prefix restore would resurrect exactly the class of stale entry the brief feared), and
**`describe.bench.ts`'s `HEAD~10` is not touched** — the bench is correct.

### The actual mechanism

`test/bench/checkout.bench.ts` (added by the 2026-08 perf-remediation PR as its R16 oracle)
registers two `tieredScenario(MULTI_TIERS, …)` scenarios. Each opens the **shared cached
fixture directly** — `openRepository({ cwd: fixture.cwd })` — and its `sut` alternates:

```ts
const rev = atTip ? rootCommitId : fixture.headCommitId;
atTip = !atTip;
await repo.checkout({ rev, force: true });   // …and force: false in scenario 2
```

`repo.checkout` to a bare commit oid **detaches HEAD**, rewrites the index, rewrites the
working tree and appends a reflog entry — into `~/.cache/tsgit-bench/<label>-v3`, the
directory whose own type docstring reads *"Cached repo path. Never delete it — it is the
cache."* (`ScaledFixture.cwd`, `test/bench/support/fixture-generator.ts`).

Local proof, read out of the live cache:

```
$ git -C ~/.cache/tsgit-bench/small-v3 rev-parse --symbolic-full-name HEAD
HEAD                                    # detached — a pristine fixture answers refs/heads/main
$ git -C ~/.cache/tsgit-bench/small-v3 reflog | wc -l
94                                      # a pristine fixture has 2
$ git -C ~/.cache/tsgit-bench/small-v3 reflog --format='%h' | sort -u
ca208fa                                 # tip
e7375a7                                 # root  (rev-list --max-parents=0)
```

92 of those 94 entries alternate between exactly the root and the tip; the two at the bottom
are `fast-import` and the generator's own `checkout -f main`. `medium-v3` on the same machine,
which a partial local run never reached, still shows the pristine shape: a 2-entry reflog and
`HEAD` on `refs/heads/main`.

`vitest bench` forces `maxWorkers = 1` (`resolved.maxWorkers = 1` when
`!(options.fileParallelism ?? mode !== "benchmark")`, and `vitest.bench.config.ts` sets no
`fileParallelism`), so bench files run **sequentially** in a stable order and
`checkout.bench.ts` always precedes `describe.bench.ts`. `describe.bench.ts` then runs, per
tier:

```
git -C <fixture> tag -f -a bench-describe-near -m bench-describe-near HEAD~10
```

Pinned against real `git` (2.55.0, `mktemp` throwaway, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, all `GIT_*` scrubbed, 3-commit repo detached at the root):

| state of `HEAD` | command | stdout/stderr | exit |
|---|---|---|---|
| detached at the **root** commit | `git tag -f -a t -m t HEAD~10` | `fatal: Failed to resolve 'HEAD~10' as a valid ref.` | 128 |
| detached at the **root** commit | `git rev-parse HEAD~10` | `fatal: ambiguous argument 'HEAD~10': unknown revision or path not in the working tree.` | 128 |
| on `refs/heads/main` (50 commits) | `git tag -f -a t -m t HEAD~10` | *(silent)* | 0 |

Row 1 is byte-identical to the CI failure. The failure therefore fires whenever **either**
tier's last checkout lands on the root commit — a parity set by tinybench's iteration count,
stable for a given machine and workload but not guaranteed. That is why `main` went red on
four consecutive runs while the local cache happens to sit at tip parity (and is still
**detached**, i.e. still not pristine — which is what the Part 2 guard catches).

### The rule this violates already exists in the suite

- `test/bench/maintenance.bench.ts` — `copyToScratch(sourceCwd, slug)`, docstring: *"the
  cache must stay pristine for every other bench file that resolves the same spec"*. Both
  scaled scenarios there copy first.
- `test/bench/status-dirty.bench.ts` — *"the cached tier fixtures are read-only shared caches
  and cannot be dirtied"*.
- `ADR-054` — *"The cached directory is never deleted by benches."*

Write-surface audit of every bench that touches `fixture.cwd`:

| bench | writes into the shared fixture | verdict |
|---|---|---|
| `checkout.bench.ts` | `HEAD`, index, working tree, reflog | **the defect** |
| `describe.bench.ts` | `refs/tags/bench-describe-near` + one tag object | additive, idempotent, `HEAD` untouched |
| `name-rev.bench.ts` | one dangling `commit-tree` object (pinned dates ⇒ stable oid) + `refs/tags/bench-name-rev-near` | additive, idempotent, `HEAD` untouched |
| `maintenance.bench.ts` | none — copies first | compliant |
| the remaining 12 (`blame`, `cat-file`, `delta-chain-read`, `diff`, `diff-recursive`, `diff-whitespace`, `log`, `midx-lookup`, `pack-read`, `rev-parse`, `show`, `status`) | none — `status()` writes no refreshed index back | compliant |

Of the 30 bench files, exactly 16 import `scaled-bench` / `tiered-bench` / `fixture-generator`
and therefore resolve a cached fixture; the audit above covers all 16. The other 14
(`closure`, `fsck-artefacts`, `pack-offset-table`, `status-dirty`, `loose-read`, `add`,
`commit`, …) build their own throwaway repos through `test/bench/fixtures.ts` or
`test/bench/support/write-scratch.ts` and never touch the shared cache.

### Constraining decisions

- **ADR-054** (bench fixture generation & caching) — the cache is version-keyed, the version
  constant is the `actions/cache` key, *"the cached directory is never deleted by benches"*.
  Part 2 **refines** it: `ensureScaledFixture` — the generator, not a bench — gains the right
  to replace a directory it can prove is not the one it wrote. Surfaced as D3/D4, not decided
  here.
- **ADR-474** (fixture-generator topology) and **ADR-503** (size taxonomy tiers) — fix the
  spec/strategy shape. Neither is changed: no new label, no new strategy, no tier change.
- `docs/design/perf-remediation-2026-08.md` R16 requires `test/bench/checkout.bench.ts` to
  exist and to compare medians before/after. Running it on a copy preserves that oracle
  (§ Part 1, measurement neutrality).
- **ADRs 791–799** now settle every decision candidate below. Two of them fold work this
  design had listed as out of scope back in: **ADR-798** (`resolveScaledContext` skips only on
  an unavailable fixture — § Part 5) and **ADR-799** (stale caches are reclaimed only by an
  explicit `--prune` — § Part 6). Both are user rulings, not designer recommendations.

### Problem B — the `check:deps` treadmill (confirmed as briefed)

`package.json` → `wireit.check:deps.command`:

```
sh -c 'npm outdated || ! npm outdated 2>/dev/null | tail -n +2
  | grep -v "^@ls-lint/ls-lint " | grep -v "^typescript " | grep -v "^knip "
  | grep -v "^jscpd " | grep -v "^vitest " | grep -v "^@vitest/coverage-v8 " | grep -q .'
```

`@cloudflare/workers-types` publishes a date-versioned release (`5.<date>.<n>`) **every
day**; it has no exception in that chain. A `grep -v "^@cloudflare/workers-types "` filter
existed until the v4 → v5 migration removed it, and the follow-up PR dropped the manifest
prose note — the treadmill re-opened the moment the filter left. Dependabot has no `ignore`
for it and its two prior bump PRs were closed unmerged.

Local `npm outdated` right now:

| package | current | latest | status |
|---|---|---|---|
| `@vitest/coverage-v8` | 4.1.11 | 5.0.0 | excepted — **do not bump** |
| `cspell` | 10.2.1 | 10.2.2 | **the one real bump** |
| `jscpd` | 5.0.16 | 5.1.2 | excepted — **do not bump** |
| `knip` | 6.33.0 | 6.34.0 | excepted — **do not bump** |
| `typescript` | 6.0.3 | 7.0.2 | excepted — **do not bump** |
| `vitest` | 4.1.11 | 5.0.0 | excepted — **do not bump** |

`@cloudflare/workers-types` is absent today only because `package.json` already pins
`5.20260904.1` — today's release. It will re-appear by PR time. Every exception's rationale
lives in `.claude/workflow.md`'s `pre-pr-gate` bullet; the new one belongs there in the same
style.

### Where the original brief lives

The brief is reproduced in full, unedited, in the resolved-brief artifact this design was
written from; the divergence table above quotes its two proposed fixes and its DO-NOTs
verbatim, which is the whole of what this design either adopts or sets aside.

## Requirements

Verifiable statements that must hold when this ships.

1. **R1** After a full `npm run test:bench`, every cached fixture under
   `${XDG_CACHE_HOME:-~/.cache}/tsgit-bench/` answers `refs/heads/main` to
   `git rev-parse --symbolic-full-name HEAD`, and `git rev-parse refs/heads/main` equals its
   `meta.json`'s `headCommitId`.
2. **R2** `describe.bench.ts`'s `TAG_DISTANCE` / `HEAD~10` and `name-rev.bench.ts`'s
   `DAY_AND_A_BIT` keep their current values, and neither bench's measured `sut` changes.
   (ADR-795 settles D5 as (a): both files are untouched entirely.)
3. **R3** `test/bench/checkout.bench.ts` still registers the same two scenarios at the same
   tiers with the same describe titles and the same `bench('tsgit', …)` name, so the
   `benchmark-snapshot` series and the `bench-to-snapshot` / `bench-summarize` keys are
   unbroken.
4. **R4** Exactly one implementation of "copy a cached fixture into a disposable scratch
   directory" exists under `test/bench/`, and every bench that needs a mutable fixture uses
   it — at minimum `maintenance.bench.ts` and `checkout.bench.ts`.
5. **R5** `ensureScaledFixture` returns a cached fixture only after proving its identity;
   on a mismatch it writes a warning naming the fixture label and the mismatch to `stderr`,
   replaces the directory, and returns a fixture that satisfies R1.
6. **R6** The replacement path never leaves a partially deleted repository visible at the
   shared cache path, and never fails with `ENOTEMPTY`.
7. **R7** When git cannot execute the tip probe (any exit code other than 0 or 1), or the
   HEAD file cannot be read for a reason other than being absent, a cache hit still returns
   the cached fixture — an unverifiable cache is never destroyed, and the warning names the
   cause and the directory to delete. With `git` absent from `PATH` a pristine HEAD file is
   trusted the same way; a mismatch proven from the HEAD file cannot be repaired without git
   and is reported as an unavailable fixture instead of being handed out.
8. **R8** `npm run check:deps` is green on a day when `@cloudflare/workers-types` has
   published a newer release than the pinned one, and still **red** when any
   non-excepted package is stale.
9. **R9** `.claude/workflow.md`'s `pre-pr-gate` bullet records the new exception's rationale.
10. **R10** `npm run validate` is green at every commit; no `restore-keys` are added to any
    `actions/cache` step; no ignore/suppression directive is introduced.
11. **R11** The fix is demonstrated on a real runner **before** merge, on both the
    cache-miss and the cache-restore path — `benchmark-snapshot` runs only on `push` to
    `main`, so a local pass proves nothing for problem A. The mechanism is D7.
12. **R12** `resolveScaledContext` returns a fixture-less (skipped) context only when the
    fixture is unavailable — `git` absent — or when `STRYKER_MUTANT_ID` is set. Every other
    failure raised by `ensureScaledFixture` propagates and fails the bench file. Both halves
    are pinned by unit tests that never build a scaled fixture.
13. **R13** `npm run bench:fixture -- --prune` removes, under the cache root, exactly the
    stale `<label>-v<N>` directories for known labels — stale meaning `N` **older than**
    the current version (D10, settled by ADR-799) — plus every `.tmp.<pid>.<ms>`,
    `.corrupt.<pid>.<ms>` or `.scratch.<pid>.<random>` sibling of a known-label directory
    whose pid no longer belongs to a running process, and nothing else. It reports each removed path with its
    byte count, leaves the cache root and every current-version directory in place, and exits
    non-zero if any removal failed. No other code path removes a cache directory — R5's
    identity-probe replacement is the only exception.

## Design

Six parts, six commits, one PR. Parts 1 and 2 both land here — § Part 2's *Ordering* table
shows what each covers that the other cannot. Part 5 lands **after** Part 2: it is what makes
Part 2's warning reachable instead of swallowed, and it is what turns a failed rebuild into a
red run. Part 6 depends only on the two exports it adds to the generator. Parts 3 and 4 are
independent of everything.

---

### Part 1 — `checkout.bench.ts` runs on a disposable copy; one shared copy helper

**Pre-chewed context**

| what | where |
|---|---|
| The defect | `test/bench/checkout.bench.ts` lines 32 and 54 — `openRepository({ cwd: fixture.cwd })` |
| The helper to extract | `copyToScratch` — currently a module-private function in `test/bench/maintenance.bench.ts` (lines ~54-59), called at lines 72 and 164 |
| Sibling scratch module (shape to mirror, not to extend) | `test/bench/support/write-scratch.ts` — `ScratchRepo = { cwd, repo, dispose }`, `newScratch`, `disposeScratch` |
| Scenario registration path | `test/bench/support/tiered-bench.ts` `tieredScenario` → `test/bench/support/scaled-bench.ts` `scaledScenario` → `test/bench/support/bench-dsl.ts` `benchScenario` (`describe.skipIf(skip)(title, async () => { … await build() … })`) |
| Fixture the copy is taken from | `ScaledFixture` from `test/bench/support/fixture-generator.ts` — `{ cwd, headCommitId, firstBlobId, lastBlobId?, spec }` |

**New module — `test/bench/support/fixture-scratch.ts`**

```ts
export interface FixtureScratch {
  /** Disposable byte-copy of a cached fixture — safe to mutate. */
  readonly cwd: string;
  dispose(): Promise<void>;
}

export const copyFixtureToScratch = async (
  sourceCwd: string,
  slug: string,
): Promise<FixtureScratch> => { … };   // mkdtemp(tmpdir/`tsgit-bench-${slug}-`)
                                       // + cp(sourceCwd, cwd, { recursive: true, preserveTimestamps: true })
                                       // dispose = rm(cwd, { recursive: true, force: true })
```

*Superseded by § Review refinements (4) and (9):* the copy is created beside its source
(`mkdtemp(\`${sourceCwd}.scratch.${process.pid}.\`)`, no `slug`), and the returned shape is
`{ cwd, dispose, disposeSync }` — the scenario's `teardown` (not `afterAll`, which never runs
under `vitest bench`) calls `disposeSync` first. Same `fs.cp` body as today's `copyToScratch`. The module imports
nothing from `src/` — that is the reason it does not live in `write-scratch.ts`, which exists
to *build* repos through the library API (D1).

**`checkout.bench.ts` per scenario**

```ts
async (fixture) => {
  const scratch = await copyFixtureToScratch(fixture.cwd, `checkout-force-${fixture.spec.label}`);
  const repo = await openRepository({ cwd: scratch.cwd });
  afterAll(async () => {
    await repo.dispose();      // close pack handles BEFORE removing the tree
    await scratch.dispose();
  });
  …unchanged: log({order:'first-parent'}) → rootCommitId, the alternating sut…
}
```

One `afterAll` with an explicit order, not two — `repo.dispose()` must close the pack file
handles before the directory is removed; relying on vitest's hook ordering would be an
unstated assumption. Scenario 2 uses `checkout-no-force-${fixture.spec.label}`: the slug
carries both the variant and the tier so the four scratch directories that coexist during the
file's run stay readable in `/tmp`.

The module docstring gains one paragraph in the file's existing voice — that each tier runs
on a disposable copy of the cached fixture because `checkout` moves `HEAD`, rewrites the index
and rewrites the working tree, and the cache is reused byte-for-byte by every other bench file
resolving the same spec. Without that line the next reader has no way to know the copy is
load-bearing rather than incidental.

**`maintenance.bench.ts`** — delete the private `copyToScratch`, import
`copyFixtureToScratch`, rewrite its two call sites, and drop the now-unused `cp` import
(`mkdtemp`, `rm`, `os`, `path` are still used by the cruft scenario — do not drop those, and
do not let `knip` see a dangling `cp`).

**Measurement neutrality — priced, not hand-waved**

Copy cost, measured on this machine (darwin, APFS, `fs.cp` recursive + `preserveTimestamps`):

| fixture | on-disk | copy | remove |
|---|---|---|---|
| `small-v3` | 1.6 MB | **151 ms** | 22 ms |
| `medium-v3` | 133 MB (55 MB `.git` + 78 MB / 20 000 working files) | **10 538 ms** | 779 ms |

Four copies today (2 scenarios × 2 tiers) ⇒ **≈ 21 s** added collection time per suite run,
≈ 1.6 s teardown, ≈ 270 MB peak extra disk. `bench.yml`'s budget is 30 minutes and
`maintenance.bench.ts` already copies a 133 MB fixture inside a describe body on every green
CI run since 2026-08-16 — the precedent exists. Under `TSGIT_BENCH_LARGE` the large tier adds
two ~500 MB copies; that path is opt-in and never runs in CI.

The orchestrator's pre-chewed context flagged a risk that the copied index's stat data (inode/dev no longer
matching the copy) would make the first no-force `checkDirty` re-hash. **Reading the code,
that risk does not exist**: `evaluateDirtyPath` in
`src/application/primitives/apply-changeset.ts` consults **no index stat cache at all** —

- an `update`/`delete` entry goes to `isWorkingTreeDirty` → `exists` + full read + `serializeAndHash`, unconditionally, on every call;
- an `add` entry goes to `isUntrackedClash` → `exists` only.

So the no-force variant hashes the same bytes on the copy as on the original, on every
iteration including the first. `preserveTimestamps: true` is kept anyway — it costs nothing
and keeps the copy indistinguishable from the source for any future stat-sensitive path. The
only genuine difference is OS page-cache warmth, and the copy itself writes those bytes, so
the copy is warm.

**`actions/cache` key:** unchanged. The key hashes only
`test/bench/support/fixture-generator.ts`, which Part 1 does not touch.

---

### Part 2 — `ensureScaledFixture` proves fixture identity before trusting a cache hit

**Pre-chewed context**

| symbol | file / line | current signature |
|---|---|---|
| `FIXTURE_GENERATOR_VERSION` | `test/bench/support/fixture-generator.ts:25` | `const … = 3` |
| `FixtureMeta` | `:227` | `{ version, headCommitId, firstBlobId, lastBlobId?, spec }` |
| `FixtureUnavailableError` | `:235` | `class … extends Error` |
| `cacheDirFor` | `:249` | `(spec) => path.join(cacheRoot(), \`${spec.label}-v${VERSION}\`)` |
| `gitEnv` | `:~430` | strips every `GIT_*` from the child env |
| `runGit` | `:436` | `(repoDir, args) => Promise<string>` — `execFile git -C`, trimmed stdout, **rejects on non-zero exit** |
| `assertGitAvailable` | `:~445` | `() => Promise<void>`, throws `FixtureUnavailableError` |
| `generateInto` | `:619` | `(repoDir, spec) => Promise<FixtureMeta>` |
| `readCachedMeta` | `:639` | trusts `meta.version === FIXTURE_GENERATOR_VERSION` **alone** |
| `ensureScaledFixture` | `:657` | the choke point — both `resolveScaledContext` and `tooling/gen-bench-fixture.ts` go through it |
| Sole caller that swallows | `test/bench/support/scaled-bench.ts` `resolveScaledContext` — bare `catch { return { given } }` |

**Why identity, and not commit count**

Commit count is strategy-dependent: `deep-ancestry` yields `commits + 1`, `many-pack` yields
`packs` commits, `loose-only` and `single-pack` yield 1. Identity is strategy-agnostic and
verified from the generator source — **every** strategy path ends with
`runGit(repoDir, ['checkout', '-f', 'main'])`:

| strategy | function | terminal step |
|---|---|---|
| `multi`, `deep-ancestry` | `generatePacked` | `checkout -f main` → `repack -ad --quiet` |
| `evolving` | `generateEvolving` | `checkout -f main` → `repack -adf …` |
| `many-pack` (`packs ≥ 1`) | `generateManyPack` | loop → `checkout -f main` → optional `multi-pack-index write` |
| `many-pack` (`packs === 0`) | `generateManyPack` early return | `checkout -f main` |

`generateInto` then records `headCommitId = rev-parse HEAD`. So a pristine fixture always
satisfies, for every spec:

```
git rev-parse --symbolic-full-name HEAD  ==  "refs/heads/main"
git rev-parse refs/heads/main            ==  meta.headCommitId
```

Pinned against real `git` 2.55.0 in a `mktemp` throwaway:

| repo state | `rev-parse --symbolic-full-name HEAD` | exit | `rev-parse refs/heads/main` | exit |
|---|---|---|---|---|
| on `main` | `refs/heads/main` | 0 | `<oid>` | 0 |
| detached | `HEAD` | 0 | `<oid>` | 0 |
| detached (`symbolic-ref -q HEAD`) | *(empty)* | **1** | — | — |

*Superseded by § Review refinements (1) and (6):* the shipped guard reads the `.git/HEAD`
**file** first (exactly `ref: refs/heads/main`, or a proven mismatch) and then runs only
`rev-parse --verify -q refs/heads/main^{commit}` through a helper that reports the exit code —
exit 1 is the proven "missing" the guard acts on, and any other failure keeps the cache. The
matrix below was pinned on git 2.55.0 while `symbolic-ref -q` was still the HEAD probe and is
kept as evidence for the exit-code split: detached ⇒ `symbolic-ref -q` exit 1; ref deleted ⇒
`rev-parse --verify -q` exit 1; not a repository / garbage `.git/HEAD` ⇒ 128.

**What the guard deliberately does not check.** It catches `HEAD` and `refs/heads/main`
movement. It does **not** catch a merely dirty working tree, an extra tag, or a dangling
object — by design: `describe.bench.ts` and `name-rev.bench.ts` legitimately add tags and one
dangling commit, and `meta.json` itself is an untracked file inside the fixture working tree
(`git status --porcelain` on a pristine `small-v3` prints exactly `?? meta.json`), so any
cleanliness check would have to special-case it and would cost an O(20 000-file) scan per
resolution. D3 offers that stronger variant as an alternative.

**Shape**

```ts
const PRISTINE_HEAD_NAME = 'refs/heads/main';

interface FixtureIdentity {
  readonly headSymbolicName: string;
  readonly mainCommitId: string;
}

const readFixtureIdentity = async (cacheDir: string): Promise<FixtureIdentity> => ({
  headSymbolicName: await runGit(cacheDir, ['rev-parse', '--symbolic-full-name', 'HEAD']),
  mainCommitId: await runGit(cacheDir, ['rev-parse', PRISTINE_HEAD_NAME]),
});

/** `undefined` when the cached repo still matches what `generateInto` wrote. */
const identityMismatch = (identity: FixtureIdentity, meta: FixtureMeta): string | undefined => {
  if (identity.headSymbolicName !== PRISTINE_HEAD_NAME)
    return `HEAD is ${identity.headSymbolicName}, expected ${PRISTINE_HEAD_NAME}`;
  if (identity.mainCommitId !== meta.headCommitId)
    return `${PRISTINE_HEAD_NAME} is ${identity.mainCommitId}, expected ${meta.headCommitId}`;
  return undefined;
};

// Superseded by § Review refinements (1): the shipped code returns a three-way
// CacheVerdict — pristine | mismatch(reason) | unverifiable(reason) — and only a
// mismatch ever reaches retireCacheDir.
const cacheRejection = async (cacheDir: string, meta: FixtureMeta): Promise<string | undefined> => {
  try {
    return identityMismatch(await readFixtureIdentity(cacheDir), meta);
  } catch (err) {
    if (!(await gitAvailable())) return undefined;          // R7 — degrade, do not fail
    return `git could not read its refs (${err instanceof Error ? err.message : String(err)})`;
  }
};
```

Two supporting extractions, both behaviour-preserving:

```ts
/** Predicate half of the existing `assertGitAvailable`, which becomes its throwing wrapper. */
const gitAvailable = async (): Promise<boolean> => { … };

/** The `ScaledFixture` literal `ensureScaledFixture` currently spells out twice. */
const toScaledFixture = (cacheDir: string, meta: FixtureMeta, spec: FixtureSpec): ScaledFixture =>
  ({ cwd: cacheDir, headCommitId: meta.headCommitId, firstBlobId: meta.firstBlobId, spec,
     ...(meta.lastBlobId !== undefined ? { lastBlobId: meta.lastBlobId } : {}) });
```

`assertGitAvailable` is split into a `gitAvailable(): Promise<boolean>` predicate plus the
existing throwing wrapper, so the guard can ask the question without catching a thrown
sentinel. The error is never swallowed: it is either re-classified into a rejection reason
carrying its own message, or attributed to a documented absent-`git` condition.

**Replacement, not deletion-in-place**

```ts
/** Moves a non-pristine cache aside atomically, then removes it. A no-op when absent. */
const retireCacheDir = async (cacheDir: string): Promise<void> => {
  const retired = `${cacheDir}.corrupt.${process.pid}.${Date.now()}`;
  try {
    await rename(cacheDir, retired);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return;                       // absent, or another process already retired it
  }
  await rm(retired, { recursive: true, force: true });
};
```

Two failure modes this shape exists to avoid, both pinned:

- `rename(tmpDir, cacheDir)` onto an **existing non-empty** directory throws
  `ENOTEMPTY: directory not empty` (node 22.22.3, darwin; POSIX `rename(2)` for every
  runner). Onto an **empty** directory it succeeds. That is exactly why the brief's fix 2
  would have re-failed — the `catch` would re-read the corrupt cache and return it.
- An in-place `rm(cacheDir, { recursive: true })` would leave a **half-deleted repository**
  visible at the shared path for the whole rebuild — objects and refs disappearing under a
  concurrent reader, which is worse than a clean `ENOENT`. The rename-aside window is one
  syscall.

**Rewritten `ensureScaledFixture`**

```ts
const warnNotPristine = (spec: FixtureSpec, reason: string): void => {
  process.stderr.write(
    `[bench] cached fixture "${spec.label}" is not pristine: ${reason}. Rebuilding it. ` +
      `A bench mutated the shared cache — copy it first ` +
      `(test/bench/support/fixture-scratch.ts).\n`,
  );
};

export const ensureScaledFixture = async (spec: FixtureSpec): Promise<ScaledFixture> => {
  const cacheDir = cacheDirFor(spec);
  const cached = await readCachedMeta(cacheDir);
  if (cached !== undefined) {
    const rejection = await cacheRejection(cacheDir, cached);
    if (rejection === undefined) return toScaledFixture(cacheDir, cached, spec);
    warnNotPristine(spec, rejection);
  }
  // git first: never destroy a cache directory we could not rebuild.
  await assertGitAvailable();
  // Also covers a directory that exists with no readable `meta.json` — without
  // this the generate path's `rename` would hit ENOTEMPTY on it (see below).
  await retireCacheDir(cacheDir);
  await mkdir(cacheRoot(), { recursive: true });
  const tmpDir = `${cacheDir}.tmp.${process.pid}.${Date.now()}`;
  let meta: FixtureMeta;
  try {
    meta = await generateInto(tmpDir, spec);
    await writeFile(path.join(tmpDir, 'meta.json'), JSON.stringify(meta), 'utf8');
    await rename(tmpDir, cacheDir);
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    const won = await readCachedMeta(cacheDir);
    if (won === undefined) throw err;
    // A losing race reuses the winner's cache — but only after the winner's
    // directory passes the same identity check the hit path applies.
    const rejection = await cacheRejection(cacheDir, won);
    if (rejection !== undefined) {
      warnNotPristine(spec, rejection);
      throw err;
    }
    meta = won;
  }
  return toScaledFixture(cacheDir, meta, spec);
};
```

`retireCacheDir` is unconditional after the hit branch, which closes a **pre-existing** hole
the brief was right to worry about even though its mechanism was wrong: a `cacheDir` that
exists but whose `meta.json` is missing or unparseable makes `readCachedMeta` return
`undefined`, and today's generate path then hits `ENOTEMPTY` on the `rename` and the `catch`
re-reads the same unreadable cache and rethrows. That is the shape closest to the truncated
entry the brief described, and it is now handled. On a true first run `retireCacheDir` costs
one `rename` that returns `ENOENT` and is discarded.

`assertGitAvailable()` moves **above** `retireCacheDir` so a missing `git` can never leave a
developer with a destroyed cache and no way to rebuild it. On the corrupt-with-meta path the
check is redundant — `cacheRejection` only returns a reason when `git` answered — but it costs
one spawn on a path that is about to spend seconds regenerating.

In the double-race branch the error surfaced is the original `rename`/generate failure, not
the identity mismatch — the warning is emitted first so the cause is still on `stderr`.

`toScaledFixture(cacheDir, meta, spec)` extracts the object literal that the current function
already spells out twice (`{ cwd, headCommitId, firstBlobId, spec, ...(lastBlobId ? … : {}) }`)
— a DRY tidy, not a behaviour change. Note `jscpd` runs as `jscpd src/` only, so nothing
mechanical would have flagged that duplicate; this is a house-rule fix, and the same honesty
applies to Part 1's helper extraction.

**The warning must be written from inside the generator.** As written, `resolveScaledContext`'s
`catch { return { given } }` swallows every exception `ensureScaledFixture` can raise and turns
it into a silently **skipped** scenario — a thrown "corrupt fixture" error would vanish from the
bench output entirely. Part 5 removes exactly that swallow, so this is no longer the argument
against D3(b); what survives it is ADR-793's own reason, which does not depend on the catch:
throwing leaves every already-mutated local cache broken until someone removes it by hand, while
replacing self-heals in 147 ms (small) / 3.65 s (medium). The conclusion is unchanged — the
warning is written where the mismatch is *proved*, so it can name the label and the observed
value, and the generator is the only place that holds both.

**Cost of the guard.** Measured: two `git` spawns = **15.4 ms** per resolution; a cache hit
costs 0 ms today. Counted across the suite: 16 bench files, 12 `tieredScenario` calls (2 tiers
each) + 14 direct `resolveScaledContext` calls = **38 resolutions** per run (50 under
`TSGIT_BENCH_LARGE`) ⇒ **≈ 0.6 s** added to a run whose budget is 30 minutes. Both probes are
O(1) in history size, so `header-cache` (70 000 commits) pays the same 15 ms.

**Cost of a rebuild, measured** (isolated `XDG_CACHE_HOME`, darwin; artifact verified after
the fact — 5 000 commits, 20 000 tracked files, `HEAD` on `refs/heads/main`, 133 MB, identical
to the long-lived cache, so the timer is measuring a real fixture and not a short-circuit):

| fixture | cold generate | warm hit |
|---|---|---|
| `small` | **147 ms** | 0 ms |
| `deep-ancestry-medium` | **124 ms** | 0 ms |
| `medium` | **3 650 ms** | 0 ms |

Generation is seconds, not minutes — which also defuses the cost objection to busting the
`actions/cache` key (D4).

**Ordering — Parts 1 and 2 ship together, and neither is redundant.** Each part alone would
turn CI green; the honest reason to ship both is that each covers what the other cannot:

| shipped | CI (`benchmark-snapshot`) | a developer's already-mutated local cache | residual |
|---|---|---|---|
| Part 1 only | green — Part 1 does not touch `fixture-generator.ts`, so the key is unchanged and CI keeps restoring the **pristine** 2026-08-16 entry: an exact-key hit never re-saves, so no run has ever written its in-run mutation back. Nothing mutates it thereafter | **still red on ~half of machines**: `small-v3` stays detached at whatever parity it stopped at, and nothing repairs it short of a manual `rm -rf` | the next bench that forgets the rule fails the same way, with the same unhelpful `HEAD~10` message |
| Part 2 only | green — but with `maxWorkers = 1`, `checkout.bench.ts` still mutates and *every* later tiered file trips the guard, rebuilds (147 ms small / 3.65 s medium) and re-emits the warning, on every run | repaired | the warning fires every run, so it is learned-and-ignored and stops being a signal |
| both | green | repaired | the warning stays silent, and therefore means something the day it appears |

**`actions/cache` key: this part changes it.** The key is
`tsgit-bench-${{ hashFiles('test/bench/support/fixture-generator.ts') }}` in both
`.github/workflows/ci.yml` (`benchmark-snapshot`, `benchmark-compare`) and
`.github/workflows/bench.yml`. Editing that file for the guard changes the hash ⇒ one cold
regeneration on the first run under the new key, then the entry is saved. Consequences to
expect, not to be surprised by:

- A cache saved on the feature branch is **not** visible to `main` — GitHub Actions restores
  only from the current branch and the default branch. `main`'s first post-merge
  `benchmark-snapshot` therefore pays its own cold build (~seconds per fixture) and saves the
  entry for every later run.
- `benchmark-compare` keys on `hashFiles('head/test/bench/support/fixture-generator.ts')`, i.e.
  the same hash — the `head/` prefix names the file, not the content — so it shares the
  branch's entry. It also checks out **base and head side by side and runs both against one
  `~/.cache/tsgit-bench`**: the base tree still carries the mutating `checkout.bench.ts`, so on
  a labelled PR the base side would dirty the fixture and the head side's guard would repair it
  every round. Instructive, but not a measurement — see D7.
- `benchmark-snapshot` builds `small`, `medium`, `medium-commit-graph`, `delta-chain`,
  `deep-ancestry-{small,medium}`, `many-pack`, `many-pack-no-midx`, `single-pack`,
  `loose-only`. It does **not** build `header-cache` or `small-fat-blob` — those are reached
  only by `tooling/bench-memory.ts` (`npm run bench:memory`), which runs in `bench.yml`.
- `bench.yml` has already been cold-building `header-cache` on **every** nightly since it was
  added: `header-cache` arrived in the same commit that last changed the generator
  (`3f5b9ba6`, merged 2026-08-16 19:41 UTC), and the surviving entry was written 9 minutes
  later by `benchmark-snapshot` — which runs `test:bench` and never `bench:memory`, the only
  caller of `HEADER_CACHE_FIXTURE` and `SMALL_FAT_BLOB_FIXTURE`. The nightly (03:14 UTC) has
  restored that entry on an exact-key hit ever since, and an exact-key hit never re-saves.
  Nothing about that regresses here.

**Documentation touched by this part.** `ScaledFixture.cwd`'s docstring —
*"Cached repo path. Never delete it — it is the cache."* — becomes
*"Cached repo path. Never delete or mutate it — it is the shared cache; copy it first
(`fixture-scratch.ts`)."*

---

### Part 3 — `check:deps` exception for `@cloudflare/workers-types` + manifest rationale

**Pre-chewed context**

| what | where |
|---|---|
| The grep chain | `package.json` → `wireit["check:deps"].command` (single line, `sh -c '…'`) |
| Wireit inputs | `wireit["check:deps"].files = ["package.json", "package-lock.json"]` — editing the command itself invalidates the cached result |
| Rationale home | `.claude/workflow.md`, the `pre-pr-gate: npm outdated` bullet (lines ~35-53), where all six current exceptions are justified in prose |
| Dependabot | `.github/dependabot.yml` — weekly npm, groups `stryker`/`rollup`/`vitest`, **no** `ignore` rules |

**Change.** Append one filter to the chain, after the `@vitest/coverage-v8` link (the chain
is append-ordered by when each exception was added, not alphabetical):

```
… | grep -v "^@vitest/coverage-v8 " | grep -v "^@cloudflare/workers-types " | grep -q .
```

The **trailing space** in each pattern is load-bearing — `npm outdated` pads the package
column with at least one space (verified in the live output above), and without it
`^@cloudflare/workers-types` would also swallow a hypothetical
`@cloudflare/workers-types-extra`. The `^` anchor already keeps `^vitest ` from matching
`@vitest/coverage-v8`.

Control-flow sanity, unchanged by the addition: `npm outdated` exits 1 when anything is
stale, so the `||` right-hand side runs only then; `grep -q .` exits 0 if any *non-excepted*
line survives, and `!` turns that into a failure. All lines filtered ⇒ pass.

**Manifest text** appended to the `pre-pr-gate` bullet's *Exceptions* prose, in its voice
and without PR or phase references:

> **`@cloudflare/workers-types` is skipped**: it publishes a date-versioned release
> (`5.<date>.<n>`) every day, so bumping it makes `deps` green for exactly one day and red
> again the next morning — a treadmill, not a freshness signal. Dependabot's weekly npm PR
> keeps the pin from rotting, and a `workers-types` change that actually matters shows up as a
> type error, not as an `npm outdated` row. The exception existed before the v4 → v5 migration
> removed it; this restores it.

**`actions/cache` key:** unchanged.

---

### Part 4 — deps hygiene bump

**Pre-chewed context**

| what | where |
|---|---|
| Rule | `.claude/workflow.md` `pre-pr-gate: npm outdated` — every PR bumps what `npm outdated` flags, minus the documented exceptions |
| Today's only real row | `cspell` 10.2.1 → 10.2.2 |
| Lockfile rule | `npx npm@10 install --save-exact <pkg>@<version>` (or `--package-lock-only`); a partial lock breaks CI (`npm ci` computes different optional deps than `npm install`) |

Bump `cspell` to the latest at PR time, plus whatever else `npm outdated` flags then, **minus**
`typescript` (7.x crashes `@rollup/plugin-typescript`), `vitest` / `@vitest/coverage-v8` (4.x
pinned so a mutation regression stays attributable), `jscpd` (5.1.x has an incoherent
optional-dependency graph), `knip`, `@ls-lint/ls-lint` — each already justified in the
manifest. Land as its own `chore(deps): …` commit.

Two traps to check before committing: `npm install <pkg>@<v>` has previously **added an
unintended sibling package**, so read the `package.json` + `package-lock.json` diff rather
than trusting the command; and re-run `npx cspell` fresh (it is wireit-cached, and
`Ran 0 scripts and skipped 1` reads exactly like a pass).

**`actions/cache` key:** unchanged.

---

### Part 5 — `resolveScaledContext` skips only when the fixture is unavailable

Folded in by **ADR-798**. This design listed the bare `catch` as out of scope; the user ruled it
rides here. It is also what completes Part 2: without it, a rebuild that Part 2 starts and
cannot finish leaves the run *shorter* instead of *red* — the benchmark rows simply stop
existing, which is the one failure mode a snapshot series cannot show you.

**Pre-chewed context**

| symbol | file / line | current shape |
|---|---|---|
| `resolveScaledContext` | `test/bench/support/scaled-bench.ts:39-50` | `(spec?: FixtureSpec) => Promise<ScaledContext>`; `if (process.env.STRYKER_MUTANT_ID !== undefined) return { given };` then `try { … } catch { return { given }; }` |
| `ScaledContext` | `:17-21` | `{ readonly fixture?: ScaledFixture; readonly given: string }` — `fixture === undefined` **is** the skip signal |
| `scaledScenario` | `:53-69` | `benchScenario(…, { skip: fixture === undefined })`, and re-throws `'scaled fixture unavailable'` if a skipped body ever runs |
| module docstring | `:1-7` | *"registers a `benchScenario` that skips cleanly when the fixture cannot be built (no `git` CLI, Stryker sandbox)"* — already states the contract this part restores |
| `FixtureUnavailableError` | `test/bench/support/fixture-generator.ts:235-241` | module-**private** `class … extends Error`, `name = 'FixtureUnavailableError'`; its docstring already says *"callers catch generically and skip"* — that line changes too |
| its only throw site | `assertGitAvailable`, `:444-450` | `execFileAsync('git', ['--version'])` rejects ⇒ throw. Part 2 splits out the `gitAvailable()` predicate but keeps this wrapper as the sole thrower |
| call sites | **14 direct calls across 10 bench files**, every one a module-top-level `const ctx = await resolveScaledContext(spec)` (`pack-read.bench.ts:98`'s sits inside a top-level `if`, still top-level `await`), plus `tieredScenario`'s loop (`tiered-bench.ts:55`) — 12 calls × 2 tiers — for the 38 resolutions per run counted in § Part 2 | a rejection is a **top-level-await** rejection: vitest fails the whole bench *file*, which is the loud signal ADR-798 asks for |

**Exported narrowing surface — a predicate, not the class**

```ts
/** The one condition a bench may skip on. Every other failure must reach the runner. */
export const isFixtureUnavailable = (err: unknown): boolean =>
  err instanceof FixtureUnavailableError;
```

Why the predicate and not `export class FixtureUnavailableError`:

- ADR-798's ruling is worded that way — *"the generator exports the narrowing predicate rather
  than asking callers to inspect messages"* — and it keeps the representation private: swapping
  the class for an error code later touches one file.
- The single call site never uses the narrowed value; it skips or rethrows. So
  `err is FixtureUnavailableError` buys the caller nothing and would put a module-private name
  in an exported signature.
- Exporting the class publishes a **throwable skip token**: any bench could
  `throw new FixtureUnavailableError(…)` and vanish from the snapshot series with no warning.
  A predicate cannot be thrown.
- It is *not* forced by the compiler, and the design should not pretend otherwise. Pinned
  locally (tsc 6.0.3, `declaration: true` + `noEmit: true`, a module-private class as an
  exported guard's `err is` target): **exit 0**, no TS4060. `npm run check:types` runs
  `--noEmit` and `tsconfig.build.json` excludes `test/**`, so no declaration is ever emitted
  for this file. The choice is design, not a type error.
- The `export type *` trap that strips runtime classes does not arise either way: `scaled-bench.ts`
  imports the generator directly, not through a barrel.

**The new `catch`**

```ts
if (process.env.STRYKER_MUTANT_ID !== undefined) return { given };
try {
  const fixture = await ensureScaledFixture(resolved);
  return { fixture, given };
} catch (err) {
  if (isFixtureUnavailable(err)) return { given };
  throw err;
}
```

Two skip conditions survive, both documented: the Stryker sandbox and an absent `git`.
Everything else — a failed `fast-import`, an `ENOTEMPTY`, an `EACCES` from `retireCacheDir`, a
`TypeError` from a bad edit — propagates. No error is swallowed and none is re-wrapped: the
original error object reaches the runner with its own stack.

The module docstring gains the other half of the sentence it already carries: *any other
failure now fails the bench file rather than dropping its scenarios.*

**Interaction with Part 2 (R7), stated so it is not re-derived.** The generator's degrade path
is untouched: a cache **hit** with `git` absent still returns the cached fixture, because
`cacheRejection` asks `gitAvailable()` before classifying a probe failure. Part 5 changes only
what happens when `ensureScaledFixture` *throws*. Today's one throwing path with `git` absent —
cache miss ⇒ `assertGitAvailable()` ⇒ `FixtureUnavailableError` — still skips, byte for byte.

**Blast radius, honestly.** A developer whose cache is broken in a way Part 2 cannot prove and
repair moves from 16 quiet bench files to a red `test:bench` naming the failure. That is the
intended trade, and it is the direction the tooling already points (§ D11).

**The two tooling callers (D11, settled by ADR-798 as amended).** `tooling/profile.ts:224-232`
wraps only `ensureScaledFixture(MEDIUM_FIXTURE)`; `tooling/bench-memory.ts:984-991` wraps the
**whole** workload run, so today any workload failure is also reported as "fixture unavailable
… install the `git` CLI". Both narrow the same way: the existing message and `process.exit(1)`
stay for `isFixtureUnavailable(err)`; every other error is rethrown so it reaches the script's
own top-level error path with its real message (the plan pins where that path is in each file
and adds one if it is missing). Exit status stays non-zero on every failure; only the
diagnosis changes. Unit-testing these two CLI entry points is out of proportion to a two-line
`if`; the exported predicate is what is tested (Part 5's unit file), and the two sites are
reviewed by reading.

**`actions/cache` key: this part edits the hashed file** (one added export). Parts 2, 5 and 6
all edit `fixture-generator.ts` in the same PR, so the key is busted exactly **once**.

---

### Part 6 — `npm run bench:fixture -- --prune`, and nothing automatic

Folded in by **ADR-799**. Reclaim is a deliberate developer action; no code path deletes a
cache directory on its own except Part 2's replacement of a directory that failed its identity
probe.

**Pre-chewed context**

| what | where |
|---|---|
| argv parsing | `tooling/gen-bench-fixture.ts:23` `const label = process.argv[2]`, ternary chain `:24-33`, usage line `:35`, `process.exit(1)` `:36` |
| npm passthrough | pinned today: `npm run bench:fixture -- --prune` prints `usage: gen-bench-fixture <medium\|large\|delta-chain\|many-pack>` and exits 1 ⇒ `--prune` **does** arrive as `argv[2]` |
| module/CLI split | absent in this script; the house pattern is `invokedDirectly()` + a guarded `main().catch(…)` — `tooling/bench-check.ts:252-260`, `tooling/bench-to-snapshot.ts:113-121`, `tooling/bench-ab.ts:245` |
| cache root | `cacheRoot()` `fixture-generator.ts:243-247` — `$XDG_CACHE_HOME` (when set and non-empty) else `~/.cache`, joined with `tsgit-bench`. Module-private today |
| version constant | `FIXTURE_GENERATOR_VERSION = 3` `:25`. Module-private today |
| directory names | `cacheDirFor` `:249-250` ⇒ `<label>-v<N>`; `ensureScaledFixture`'s temp build ⇒ `<label>-v<N>.tmp.<pid>.<ms>`; Part 2's `retireCacheDir` ⇒ `<label>-v<N>.corrupt.<pid>.<ms>` |
| label vocabulary | `FixtureSpec['label']` union, `:34-48` — 14 labels, `[a-z][a-z-]*` in shape |
| node resolution trap | `gen-bench-fixture.ts` runs under `node --experimental-strip-types`, which does **not** rewrite `.js` → `.ts`. Pinned in a `mktemp` throwaway (node 22.22.3): a `.ts` module importing `./lib.js` fails with `ERR_MODULE_NOT_FOUND … lib.js imported from mid-js.ts`; the `./lib.ts` form runs. The same trap is already recorded in `tooling/bench-memory.ts`'s docstring. ⇒ `fixture-prune.ts` must import `./fixture-generator.ts`, not `./fixture-generator.js`, even though every other file in `test/bench/support/` uses the `.js` form |
| lint whitelist | `biome.json` `files.includes` is a **whitelist**. `test/**` is in it (so `fixture-prune.ts` is linted); `tooling/gen-bench-fixture.ts` and every new `tooling/test/unit/*.test.ts` are **not** — add all of them, or the new files ship unlinted and unformatted. Probed via `biome check --stdin-file-path=…` on the current `gen-bench-fixture.ts`: output byte-identical, no diagnostics, so the addition should not go red — `npm run check` is the oracle |
| knip / coverage / mutation / api | `knip.json` `project` is `src/**` only, so the new exports in Parts 5 and 6 cannot be flagged unused; `test/bench/**` is outside the coverage gate and outside Stryker's `mutate` globs, so the unit tests below are the only mechanical guard; `reports/api.json` is generated from `src/` alone, so none of these exports reaches the public-surface gate |

**Measured starting state** (read-only walk of the live cache, this machine, 2026-09-04):
21 directories, **2.01 GiB** by `du -sk` (2 111 672 KiB). Nine are stale (`N ≠ 3`):

| directory | logical bytes |
|---|---|
| `large-v1` | 1 080 819 906 |
| `medium-v2` | 108 267 879 |
| `medium-commit-graph-v2` | 107 985 985 |
| `medium-v1` | 107 690 754 |
| `small-v2` | 1 107 281 |
| `deep-ancestry-medium-v2` | 326 421 |
| `delta-chain-v1`, `delta-chain-v2` | 249 435 each |
| `deep-ancestry-small-v2` | 60 066 |
| **total** | **1 406 757 162** |

`du -sk` reports **1 765 160 KiB (1.68 GiB)** for the same nine. The report counts **logical
bytes** (sum of file sizes); the ~22 % gap is 4 KiB block rounding across ~250 000 loose
objects, not an accounting bug. Say so in the CLI's own wording rather than letting the next
reader "fix" the number against `du`.

**New module — `test/bench/support/fixture-prune.ts`** (all prune logic lives here, so later
prune edits never touch the hashed generator file and never bust the CI fixture cache)

```ts
export interface PrunedEntry {
  readonly path: string;
  /** Logical bytes — sum of file sizes under the directory, measured before removal. */
  readonly bytes: number;
}
export interface PruneFailure {
  readonly path: string;
  readonly reason: string;
}
export interface PruneReport {
  readonly root: string;
  readonly removed: readonly PrunedEntry[];
  readonly failed: readonly PruneFailure[];
}

export const pruneFixtureCache = (): Promise<PruneReport> => { … };
```

Structured data only: no rendered line, no pre-summed `bytesReclaimed`. The total is the
caller's `reduce` — a stored total is a second source of truth that can drift from `removed`,
and formatting (separators, MiB) is the CLI's job. The report carries `root` so the CLI can say
*"nothing to prune under &lt;root&gt;"* without recomputing it.

No parameters: the seam is `XDG_CACHE_HOME`, exactly as `tooling/test/unit/fixture-generator.test.ts`
already uses it. A `root` parameter would exist only for tests.

**What counts as stale — a pure, separately testable classifier**

```ts
export type CacheEntryVerdict = 'stale-version' | 'leftover' | 'keep';

const VERSIONED = /^(?<label>[a-z][a-z0-9-]*)-v(?<version>\d+)$/;
const LEFTOVER = /\.(?:tmp|corrupt)\.\d+\.\d+$/;

/** Exhaustive by construction: a new `FixtureSpec` label that is not listed fails `check:types`. */
const KNOWN_LABELS: Readonly<Record<FixtureSpec['label'], true>> = { small: true, /* …14 */ };

export const classifyCacheEntry = (name: string): CacheEntryVerdict => { … };
```

- `LEFTOVER` is tested **first** and is anchored to the exact shapes the generator builds
  (`.tmp.<pid>.<ms>` / `.corrupt.<pid>.<ms>`), not to a loose "contains `.tmp.`". The two
  patterns are disjoint anyway — `medium-v2.tmp.9.17…` cannot match `VERSIONED`'s `$` anchor —
  so the order is defensive, not load-bearing.
- The label must be **known**: membership via `Object.hasOwn(KNOWN_LABELS, label)`, no cast.
  ADR-799 says "known-label" and that is also the safe side of the sibling-worktree hazard: a
  branch that adds a label this checkout has never heard of keeps its directories.
  The `Record<FixtureSpec['label'], true>` shape is what makes the list self-correcting — the
  alternative (deriving the union from a `FIXTURE_LABELS` array exported by the generator) is
  DRY-er but restructures `FixtureSpec`, which ADR-474 fixes and this PR does not touch.
- The version predicate is `N < FIXTURE_GENERATOR_VERSION` — D10, settled by ADR-799 as
  amended: a prune run from an older checkout must never be able to remove a sibling
  worktree's newer, live fixtures; a downgrade leaves newer directories until a prune from
  that newer checkout reclaims them.

**What is never touched**

- Anything classified `keep`: current-version directories, unknown labels, and any name that is
  not `<label>-v<N>` or a leftover.
- **Symlinks.** The top-level scan is `readdir(root, { withFileTypes: true })` filtered on
  `entry.isDirectory()`, and a `Dirent` reflects `lstat`, so a symlink answers `false` and never
  reaches the removal branch. Nothing is ever dereferenced and no link target is removed.
- Plain files at the root, and the cache root itself — even when it ends up empty.
- Anything outside the root: `readdir` names cannot contain a path separator, no path is built
  from user input, and the byte walk never follows a symlink, so the traversal cannot escape.
- A directory whose byte walk failed: recorded in `failed`, left in place. Sizing is the step
  that proves the directory is readable; refusing to delete what we could not read is the
  conservative half of a destructive verb.
- A missing root (`ENOENT` on the first `readdir`) is an empty report and exit 0, not an error:
  a machine that has never run a bench has nothing to prune.

**Byte accounting.** A recursive walk, before `rm`: `readdir(dir, { withFileTypes: true })`,
recurse into real directories, `lstat(...).size` for everything else (a symlink contributes its
own link size, never its target's). Measured cost on the full stale set above — ~250 000 files,
1.4 GB — **≈ 4.0 s** wall (`find … | xargs stat`), against an `rm` that dominates it. `--prune`
is a developer verb run occasionally, so no bounded-concurrency machinery is warranted.

**Failure semantics: continue, collect, exit non-zero.** One unreadable directory must not
block reclaiming the other 1.4 GB, and a failure that only whispers is a swallowed error — so
each failure carries its path and the underlying `err.message`, prints to `stderr`, and moves
the process exit code. `rm(dir, { recursive: true, force: true })`: `force` collapses `ENOENT`
(a directory a concurrent run already removed is not a failure); every other error is caught
per directory. Bytes are measured before the removal and only enter `removed` when the removal
succeeded, so the reported total never over-reports.

**Concurrency — engineered after all** (*superseded by § Review refinements (3)*). The
first draft rejected a liveness gate; review showed the shape check alone matched the very
build another process was writing. The shipped classifier keeps any leftover whose embedded
pid is alive (`process.kill(pid, 0)`; `EPERM` counts as alive) and any leftover of an unknown
label; pid reuse can only keep a stale directory one prune longer. Stale `<label>-v<N>`
directories carry no pid and are governed by the version predicate alone.

**CLI — `tooling/gen-bench-fixture.ts`**

```ts
type FixtureAction =
  | { readonly kind: 'generate'; readonly spec: FixtureSpec }
  | { readonly kind: 'prune' }
  | { readonly kind: 'usage' };

/** Pure argv routing — exported so it can be unit-tested without running `main`. */
export const selectFixtureAction = (label: string | undefined): FixtureAction => { … };
```

The script gains the house `invokedDirectly()` guard around `main().catch(…)`, copied in shape
from `bench-check.ts` — without it, importing the module in a unit test would run `main()` and
either build a fixture or call `process.exit` inside the worker. The usage line becomes
`usage: gen-bench-fixture <medium|large|delta-chain|many-pack|--prune>`.

`--prune` occupies the same `argv[2]` slot as a label, so it cannot be combined with one: one
verb per invocation, which is what makes the router a total function over a single token. The
prune path spawns nothing — no `git`, no generation — and never creates a directory, so a
`--prune` on a machine with no `git` and no cache is a no-op that exits 0.

Rendering (the CLI's job, not the module's):

```
removed /Users/…/.cache/tsgit-bench/large-v1 (1080819906 bytes)
…
reclaimed 1406757162 bytes from 9 directories under /Users/…/.cache/tsgit-bench
```

with `could not remove <path>: <reason>` on `stderr` and exit 1 when `failed` is non-empty,
and `nothing to prune under <root>` + exit 0 when both lists are empty.

**Generator exports this part adds** — `cacheRoot` and `FIXTURE_GENERATOR_VERSION`, two `export`
keywords, no logic. That edits the hashed file, which Parts 2 and 5 already do; the key is busted
once for the PR.

**Documentation touched by this part.** Three surfaces name the pre-warm verb and the cache, and
the prune verb belongs beside each:

- `CONTRIBUTING.md:192` — `npm run bench:fixture -- medium   # pre-warm the scaled-bench fixture`
  gains a sibling line for `-- --prune`.
- `docs/understand/performance.md:45` — the *Fixtures* bullet describes `~/.cache/tsgit-bench`
  and how fixtures get there; it gains one clause on how they leave.
- `RUNBOOK.md:87-91` — the *Pre-warm the cache first* bullet. Its sentence *"The tiered benches
  skip cleanly when a fixture is unavailable"* is also the one Part 5 sharpens: it stays true,
  and gains *"any other failure fails the bench file"*.

## Decision candidates

D1–D11 are settled; the ADR that settled each says whether it was adopted as recommended or
ratified by the user. D10 and D11 were raised by this revision and settled by amending
ADRs 799 and 798 respectively, both adopted as recommended.

| # | Choice | Alternatives (≤3) | Recommendation | Why | Settled by |
|---|---|---|---|---|---|
| **D1** | Where the shared fixture-copy helper lives | (a) new `test/bench/support/fixture-scratch.ts`; (b) extend `test/bench/support/write-scratch.ts`; (c) put it in `test/bench/support/fixture-generator.ts` | **(a)** | (c) is disqualified by the CI cache key: `hashFiles('…/fixture-generator.ts')` means every future tweak to the copier would bust every fixture cache. (b) mixes two concerns and two dependency sets — `write-scratch.ts` exists to *build* repos through `openRepository`; a copier imports nothing from `src/`. | **ADR-791** — adopted as recommended |
| **D2** | Which tiers `checkout.bench.ts` runs on, given the copy cost | (a) unchanged `MULTI_TIERS`, one copy per scenario per tier (measured ≈ 21 s added collection); (b) small tier only; (c) one copy per tier shared by both scenarios (≈ 11 s) | **(a)** | (b) drops the medium-scale signal the R16 oracle was built for. (c) makes the no-force scenario's clean-tree precondition depend on the force scenario's iteration-count parity — reintroducing exactly the coupling this PR removes, to save 11 s of a 30-minute budget. | **ADR-792** — adopted as recommended |
| **D3** | What a non-pristine cached fixture triggers | (a) identity probe (`HEAD` symref + `refs/heads/main` oid) → `stderr` warning + replace; (b) identity probe → throw a distinct error and let benches skip; (c) identity probe **plus** `git status --porcelain` working-tree cleanliness → replace | **(a)** | (b) is silently swallowed by `resolveScaledContext`'s bare `catch`, turning a corrupt fixture into a missing benchmark row — the worst outcome — unless that catch is narrowed too. (c) costs an O(20 000-file) `status` scan on every one of the 38 resolutions and must special-case the fixture's own untracked `meta.json`, which is the only thing a pristine fixture's `status --porcelain` prints; it would still miss the tags and the dangling commit, which `status` does not report at all — so it buys a narrow slice of extra coverage for a wide cost. Rebuild is measured at 147 ms (small) / 3.65 s (medium), so replacing is cheap enough to be the default. | **ADR-793** — **ratified by the user** |
| **D4** | Bump `FIXTURE_GENERATOR_VERSION` 3 → 4 | (a) do not bump; (b) bump to 4 | **(a)** | Nothing about the fixture *shape* changed, so the version constant would be lying. Part 2 already busts the `actions/cache` key by editing the same file, so (b) buys no cache invalidation that is not already happening. Against it: every developer's `-v3` directories are stranded — this machine holds **2.0 GB** across `v1`/`v2`/`v3` already, and nothing ever reclaims them. The one thing (b) buys — a forced local rebuild of the already-mutated `small-v3` — the Part 2 guard does for free, and more precisely. The stranded directories are reclaimed by Part 6 instead. | **ADR-794** — **ratified by the user** |
| **D5** | `describe.bench.ts` / `name-rev.bench.ts` writing tags into shared fixtures | (a) leave as-is — additive, idempotent, `HEAD` untouched, and the D3(a) guard tolerates them by construction; (b) move both onto scratch copies for a uniform "never write a shared fixture" rule; (c) leave as-is and add a mechanical bench-suite check that fails when `fixture.cwd` reaches a writing API | **(a)** | (b) costs another ≈ 21 s per run (2 files × 2 tiers, medium dominating) to remove a class of write that has never broken anything and that the fixtures were built to absorb. (c) is the honest long-term answer but needs a taxonomy of "writing API" the repo does not have; it is a follow-up, not a chore-PR item — and per house policy a follow-up needs your explicit go rather than being filed silently. | **ADR-795** — adopted as recommended |
| **D6** | `check:deps` treatment of `@cloudflare/workers-types` | (a) grep exception + rationale in `.claude/workflow.md`; (b) exception **and** a dependabot `ignore` entry, bumped on a manual cadence; (c) no exception — pin and bump on a cadence | **(a)** | Same treadmill rationale the other six exceptions already encode. (c) reds CI on every day the cadence is missed — the status quo that opened this PR. (b) removes the one mechanism that keeps the pin from rotting (dependabot's weekly PR) in exchange for nothing: the exception already stops the row from failing the gate, whether or not a bump PR is open. | **ADR-796** — adopted as recommended |
| **D7** | How the fix is proved before merging | (a) two `gh workflow run bench.yml --ref <branch>` dispatches — first cold, second against the branch's own restored entry; (b) one dispatch (cold path only); (c) add the `bench` label so `benchmark-compare` runs on the PR | **(a)** | `benchmark-snapshot` runs only on `push` to `main`, so nothing on the PR exercises it; `bench.yml` runs the same `test:bench` under the same cache key. Only the second dispatch proves the case that has actually been failing — a *restored* fixture that `describe.bench.ts` then tags. (c) is worse than merely uninformative: `benchmark-compare` runs the base and head trees against **one shared** `~/.cache/tsgit-bench`, and the base tree still mutates it — so the head side's guard would fire every round, and the job is `continue-on-error: true` anyway. | **ADR-797** — adopted as recommended |
| **D8** | Whether `resolveScaledContext`'s bare `catch` is narrowed here (this design had it out of scope) | (a) narrow to the unavailable condition, rethrow everything else; (b) leave the bare `catch`; (c) log and skip | **(a)** | (b) hides every future generator defect — including Part 2's own rebuild failures — as a benchmark row that silently stopped existing. (c) still drops the row from the snapshot series, and one log line inside a 30-minute CI log is not a signal. | **ADR-798** — **ratified by the user**, scope fold (§ Part 5) |
| **D9** | Whether stale `<label>-v<N>` caches are ever reclaimed (this design had it out of scope) | (a) explicit `npm run bench:fixture -- --prune`; (b) automatic on the first resolution per process; (c) automatic with a 30-day age gate | **(a)** | (b) lets a `v3` bench run in one worktree delete the `v4` fixtures a sibling worktree is benchmarking, and the reverse. (c) narrows that hazard without removing it, and adds a time rule to test plus a magic number to justify. | **ADR-799** — **ratified by the user**, scope fold (§ Part 6) |
| **D10** | Which versions `--prune` removes | (a) `N !== FIXTURE_GENERATOR_VERSION` — ADR-799's literal wording; (b) `N < FIXTURE_GENERATOR_VERSION`; (c) (a) plus a typed confirmation | **(b)** | ADR-799's context says "the **previous** `<label>-v<N>` directories", and its two rejected options were rejected because worktrees at different versions would "delete each other's live fixtures". (a) re-enters that hazard in one direction: run from a `v3` checkout it deletes a sibling worktree's live `v4` fixtures — under an explicit verb, but with no way for the developer to know. (b) matches the stated intent and cannot touch a future version; its only cost is that a downgrade leaves the newer directories behind until a `--prune` from that newer checkout reclaims them. (c) adds a prompt to a verb that is already opt-in, and makes the tool interactive for the first time. | **ADR-799 (amended)** — adopted-as-recommended (no user judgment) |
| **D11** | The same misclassification in the two profiling/memory tools | (a) leave them; (b) narrow both with the exported predicate — friendly "install git" message for the unavailable case, the real error otherwise; (c) fix only the message text | **(b)** | ADR-798's consequence line says those tools "already let errors propagate". They do not, and the design should say so in its own words: `tooling/profile.ts:224-232` and `tooling/bench-memory.ts:984-991` each wrap the call in a bare `catch (err)` that prints "fixture unavailable … install the `git` CLI and retry" and exits 1 for *every* failure. The ADR's ruling is unaffected — they fail **loudly**, with a non-zero exit and the real message in the parenthesis, which is the property `resolveScaledContext` lacked — but a corrupt-fixture rebuild failure is reported as a missing `git`. With the predicate exported for Part 5, (b) is two lines per site in the same PR; (a) leaves a misdiagnosis in the two tools a developer reaches for when the benches misbehave. `tooling/gen-bench-fixture.ts` genuinely does propagate (top-level `main().catch` ⇒ message + exit 1) and needs nothing. | **ADR-798 (amended)** — adopted-as-recommended (no user judgment) |

## Test strategy

### Unit, Part 2 — `tooling/test/unit/fixture-generator.test.ts` (extend; `unit` vitest project)

The file's existing scaffold is reused verbatim: `describe.skipIf(RUNNING_UNDER_STRYKER || !HAS_GIT)`,
`XDG_CACHE_HOME` redirected to a `mkdtemp` in `beforeAll` and restored in `afterAll`, `gitEnv()`
scrubbing every `GIT_*`, Given/When/Then split across the describe tree, AAA bodies, `sut = ensureScaledFixture`.

Honest scope note: `test/bench/**` is outside the coverage gate, outside `jscpd src/`, and
outside Stryker's `mutate: ['src/**/*.ts', …]`. These tests are the **only** mechanical guard
on Part 2 — they are written to kill mutants that nothing else would.

| # | Given / When | Then (oracle) |
|---|---|---|
| T1 | a cached small fixture whose `HEAD` was detached at its root (`git checkout -q --detach $(git rev-list --max-parents=0 refs/heads/main)`) / `ensureScaledFixture(SMALL_FIXTURE)` | `git rev-parse --symbolic-full-name HEAD` is `refs/heads/main`, and the returned `headCommitId` equals the pre-corruption value — isolates the **first** guard clause |
| T2 | a cached small fixture whose `refs/heads/main` was moved to the root (`git update-ref refs/heads/main <root>`, `HEAD` still symbolic) / same call | rebuilt; `rev-parse refs/heads/main` is back at the original `headCommitId` — isolates the **second** guard clause, which T1 leaves untouched |
| T3 | a pristine cached fixture carrying a sentinel file written into its working tree / two consecutive calls | the sentinel still exists after the second call — proves the hit path does **not** rebuild, killing an always-rebuild mutant |
| T4 | a detached cached fixture with `process.stderr.write` spied / one call | the captured string contains the label `small`, the literal `refs/heads/main`, and the observed `HEAD` value — asserted on the message **data**, never `toThrow(Class)` |
| T5 | a detached cached fixture with `process.env.PATH` pointed at an empty `mkdtemp` directory for the duration of the call (restored in a `finally`) | returns the cached fixture unchanged, no throw, `HEAD` still detached — pins R7's degrade-don't-fail branch and isolates the `gitAvailable()` guard. An empty *directory* rather than an empty string: path-search semantics for an empty `PATH` string are platform-dependent, an empty directory is not |
| T6 | a populated cache directory whose `meta.json` has been deleted / one call | rebuilt successfully — pins the unconditional `retireCacheDir`; **without it this call fails with `ENOTEMPTY`**, so this test is a red-first regression test for a pre-existing hole, not a restatement of today's behaviour |
| T7 | any of T1/T2/T6's repair paths / after the call | `cacheRoot()` contains no leftover `*.corrupt.*` or `*.tmp.*` directory — proves `retireCacheDir` finishes its `rm` and the temp build is not orphaned |

T1 and T2 are deliberately separate: `if (A) return …; if (B) return …` needs one test per
clause, or a single test triggering both leaves one guard unproven. T3 exists for the same
reason in the opposite direction — without it, a mutant that drops the `if (rejection ===
undefined) return …` early exit still passes T1, T2 and T6.

No property test is warranted. Applying the four lenses: `identityMismatch` is not half of a
round-trip pair, not a compositional matcher over an array, not a total function over an
algebraic grammar, and has no idempotence/counting invariant — it is a two-clause comparison
over two strings. A property here would be a tautology.

### Unit, Part 5 — `tooling/test/unit/scaled-bench.test.ts` (new; `unit` vitest project)

`test/bench/support/**` is outside the coverage gate and outside Stryker's `mutate` globs, so
these three tests are the only mechanical guard on the narrowing.

Scaffold, decided rather than left open: **`vi.mock` with `importOriginal`, not an injected
seam.** A `deps` parameter on `resolveScaledContext` would exist solely for the test, would be
threaded through `tieredScenario` and 12 module-top-level call sites, and would widen a
zero-or-one-argument API — test-induced damage, not composition. `vi.mock` is the house
pattern (53 uses, every one of them with `importOriginal` and a `.js` specifier). The factory
replaces **only** `ensureScaledFixture` and defaults it to the real implementation
(`vi.fn(original.ensureScaledFixture)`), so the real `isFixtureUnavailable` and the real
`FixtureUnavailableError` stay in play — mocking the whole module would make the test assert
against its own stub and prove nothing. Specifier:
`'../../../test/bench/support/fixture-generator.js'`, which resolves to the same module id as
the SUT's `./fixture-generator.js` import (vite's `.js`→`.ts` resolution;
`tooling/test/unit/test-pyramid/*.test.ts` already relies on it). File-level
`describe.skipIf(RUNNING_UNDER_STRYKER)` — under Stryker `resolveScaledContext` returns before
the code these tests exercise. No `HAS_GIT` guard: two of the three never spawn anything, and
the third *requires* `git` to be unreachable.

| # | Given / When | Then (oracle) |
|---|---|---|
| U1 | `XDG_CACHE_HOME` on an empty `mkdtemp` and `PATH` on an empty `mkdtemp` (both restored in a `finally`), the spy delegating to the real generator / `resolveScaledContext(SMALL_FIXTURE)` | resolves; `fixture` is `undefined`; `given` is the exact small-fixture phrase; the spy was called. The skip is reached through the **real** `FixtureUnavailableError` and the **real** predicate — the one assertion a mocked error cannot make — and it costs one failed spawn, not a fixture build. An empty *directory* rather than an empty `PATH` string: empty-`PATH` search semantics are platform-dependent, an empty directory is not |
| U2 | the spy rejecting with `new Error('git fast-import exited with 128')` / same call | **rejects**; the caught error's `message` is exactly that string. try/catch + `.message`, never `toThrow(Class)` — the `bareClassToThrow` heuristic in `test-pyramid-budgets.json` gates that form anyway |
| U3 | `STRYKER_MUTANT_ID` set for the duration of the call (restored in a `finally`), the spy rejecting | `fixture` is `undefined` **and** the spy was never called — kills the mutant that drops the Stryker early return and lets the call fall through into the catch, which U1 alone would not notice |

U1 and U2 are separate because `if (isFixtureUnavailable(err)) return …; throw err;` has two
outcomes on one branch: one test each, or an always-return / always-throw mutant survives.

### Unit, Part 6 — `tooling/test/unit/fixture-prune.test.ts` and `gen-bench-fixture.test.ts` (both new)

`fixture-prune.test.ts` reuses `fixture-generator.test.ts`'s `beforeAll`/`afterAll`
`XDG_CACHE_HOME` mkdtemp scaffold, minus the git and Stryker guards — the module spawns
nothing. Directory trees are built with `mkdir` + `writeFile` of known byte lengths, so byte
assertions are exact rather than approximate. The pure classifier and the filesystem pass are
tested apart: the name-level table needs no I/O at all.

| # | Given / When | Then (oracle) |
|---|---|---|
| P1 | a cache root holding `medium-v2` with two files of known size / `pruneFixtureCache()` | `medium-v2` is gone; `removed` carries its path and `bytes` equal to the exact written total |
| P2 | a cache root holding `medium-v3` (the current version) / same | the directory and its files still exist; `removed` is empty — isolates the version guard |
| P3 | `medium-v3.tmp.123.1700000000000` / same | removed — isolates the `.tmp.` leftover branch |
| P4 | `medium-v3.corrupt.123.1700000000000` / same | removed — isolates the `.corrupt.` branch, which P3 leaves unproven |
| P5 | `not-a-fixture-v1` / same | kept — isolates the known-label guard, which the version guard alone would let through |
| P6 | a plain file and a directory named `scratch` at the root / same | both kept; `removed` is empty |
| P7 | an empty cache root / same | `removed` and `failed` both empty, `root` set, root itself still present |
| P8 | no cache root at all / same | empty report, no throw |
| P9 | two stale directories of different known sizes / same | each `PrunedEntry.bytes` is exact and the caller's sum matches the written total — pins the accounting, not just the removal |
| P10 | `vi.mock('node:fs/promises', importOriginal)` whose `rm` **defaults to the real one** and is overridden inside this test to reject `EACCES` for one of two stale directories / same | the other is still removed; `failed` carries the failing path **and** the reason string; the failed directory is absent from `removed`, so the byte total does not over-report. The default-to-real wiring is load-bearing: `vi.mock` is hoisted file-wide, and P1–P9 plus the `afterAll` teardown all need the genuine `rm`. Mocked rather than `chmod`-driven: a mode-based failure is platform-dependent and does not fail at all for root |
| P11 | a symlink at the cache root named like a stale directory (`skipIf(process.platform === 'win32')` — a stock Windows runner cannot create one, and the unit matrix includes `windows-latest`) / same | the link and its target both survive; `removed` is empty — pins the `Dirent.isDirectory()` filter that keeps the traversal inside the root |

`gen-bench-fixture.test.ts` pins the argv routing, which nothing else covers: a parameterised
sweep over `medium`, `large`, `delta-chain`, `many-pack`, `--prune`, an unknown token and
`undefined`, asserting the `FixtureAction.kind` and, for `generate`, `spec.label`. It is worth
the file only because the router is the single thing standing between `--prune` and the usage
line, and because a mis-route degrades silently to exit 1. It requires the `invokedDirectly()`
guard — importing the script today runs `main()`.

**No property test in either part, and here is the four-lens check so the review pass does not
re-open it.** `classifyCacheEntry` is not half of a round-trip pair (nothing serialises a
verdict back to a name), not a compositional matcher over an array of rules, and has no
idempotence or counting invariant. Lens 3 (total function over a grammar) is the near miss:
the function has no throw site to defend, and the only interesting property —
"`${knownLabel}-v${n}` is stale iff `n` is stale" — is the implementation restated, which the
house rule names as a tautology. A closed sweep of seven argv tokens and eleven directory
shapes says the same thing more legibly.

### Integration / suite-level

- **S1 (R1, the real regression oracle)** — after `npm run test:bench`, assert every
  `${XDG_CACHE_HOME:-~/.cache}/tsgit-bench/<label>-v<version>` directory answers `refs/heads/main` and
  matches its `meta.json`. Run it manually on the branch against a **deliberately
  pre-corrupted** local cache (detach `small-v3`, then run the suite) so both the repair path
  and the no-repeat-mutation property are exercised in one pass.
- **S2** — `npm run test:bench` completes with `describe.bench.ts` green at both tiers, twice
  in a row from the same cache. The second run is the one that used to fail.
- **S3** — `npm run validate` green at each commit. Watch for the known local
  oversubscription signature (timeouts only, zero assertion failures, varying failing set):
  re-run with `WIREIT_PARALLEL=1`, never `--no-verify`.
- **S4 (R12, the one path Part 5 must not break)** — with `git` removed from `PATH` and
  `XDG_CACHE_HOME` on an empty directory, `npm run test:bench` still **collects and skips**
  every scaled scenario instead of failing. No unit test exercises the whole suite's collection,
  and this is the behaviour 16 bench files depend on.
- **S5 (R13)** — build a throwaway cache root under an isolated `XDG_CACHE_HOME` mirroring the
  real one (one current-version directory, two stale, one `.tmp.` and one `.corrupt.` leftover,
  one unknown-label directory), run `npm run bench:fixture -- --prune` against it, and diff the
  surviving entries against the expected set. Then run it once for real: on this machine today
  that is nine directories and **1 406 757 162** logical bytes, against a `du` reading of
  1.68 GiB for the same nine — confirm the CLI's total matches the walk, not `du`.

### CI (R11, D7)

1. Push the branch, then `gh workflow run bench.yml --ref chore/fix-main-ci-bench-fixture-deps`.
   Expect a **cache miss** (the generator file changed ⇒ new key), a cold build of every
   fixture the suite touches, green, and a cache save scoped to the branch.
2. Dispatch a second time. Expect a **cache hit** on the branch's own entry, and green — this
   is the exact path that has been red on `main`.
3. Confirm the failure signature is gone from the log:
   `Failed to resolve 'HEAD~10' as a valid ref` must not appear, and neither must the new
   `[bench] cached fixture … is not pristine` warning (its presence on a healthy second run
   would mean a bench is still mutating).
4. `npm run check:deps` green in CI's `deps` job on a day when `@cloudflare/workers-types`
   has published past the pin (R8). Verify the negative half locally by temporarily
   downgrading an non-excepted package and confirming the gate still fails.

After merge, the first `main` push pays one cold build (branch caches are not visible to
`main`) and then `benchmark-snapshot` should publish to the `gh-pages` benchmark-data branch
for the first time since 2026-08-29.

## Out of scope

- **Adding `restore-keys` to either cache step** — explicitly forbidden by the brief; a prefix
  restore is precisely how a stale entry outlives its key.
- **Changing `describe.bench.ts`'s `HEAD~10` / `TAG_DISTANCE`, or `name-rev.bench.ts`'s
  measured `sut`** — the benches are correct; the fixture was wrong.
- **A `FixtureSpec` shape, tier or strategy change** — ADR-474 and ADR-503 stand untouched; no
  new label, no new strategy, no tier retuning. Part 6 reads the label vocabulary through an
  exhaustive `Record` in its own module rather than restructuring the union into an array.
- **Moving `describe`/`name-rev` onto scratch copies** — D5(b)/(c); ≈ 21 s per run to close a
  class of write that has never broken anything.
- **A mechanical "no writes to `fixture.cwd`" bench-suite check** — D5(c); needs a taxonomy of
  writing APIs the repo does not have.
- **Automatic reclaim of stale fixture caches** — ADR-799 rules it out explicitly: no code path
  deletes a cache directory on its own. Part 2's replacement of a directory that failed its
  identity probe is the sole exception, and it acts only on a directory it can prove is not the
  one the generator wrote. An automatic sweep — on first resolution, or age-gated — would let a
  checkout at one generator version delete the live fixtures of a sibling worktree at another.
- **Bumping `typescript`, `vitest`, `@vitest/coverage-v8`, `jscpd`, `knip`, `@ls-lint/ls-lint`**
  — each pinned for a recorded reason; bumping any of them here would make a mutation or build
  regression unattributable.
