# Design — fix the two red jobs on `main`: bench fixture mutation + the `check:deps` treadmill

> Brief: `benchmark-snapshot` has been red on `main` since 2026-08-29 because a bench
> mutates the shared cached fixture in place, and `deps` re-reds every day because
> `@cloudflare/workers-types` publishes a date-versioned release daily. Fix the cause of
> each, ship as one chore PR.
> Status: draft → self-reviewed ×3

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
   (Under D5(a) both files are untouched entirely; a D5(b) ruling would move their fixture
   acquisition onto a scratch copy without touching those constants.)
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
7. **R7** With `git` absent from `PATH`, a cache hit still returns the cached fixture — the
   guard degrades to today's behaviour rather than failing.
8. **R8** `npm run check:deps` is green on a day when `@cloudflare/workers-types` has
   published a newer release than the pinned one, and still **red** when any
   non-excepted package is stale.
9. **R9** `.claude/workflow.md`'s `pre-pr-gate` bullet records the new exception's rationale.
10. **R10** `npm run validate` is green at every commit; no `restore-keys` are added to any
    `actions/cache` step; no ignore/suppression directive is introduced.
11. **R11** The fix is demonstrated on a real runner **before** merge, on both the
    cache-miss and the cache-restore path — `benchmark-snapshot` runs only on `push` to
    `main`, so a local pass proves nothing for problem A. The mechanism is D7.

## Design

Four parts, four commits, one PR. Parts 1 and 2 both land here — § Part 2's *Ordering* table
shows what each covers that the other cannot; Parts 3 and 4 are independent of them and of
each other.

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

Same `mkdtemp` + `fs.cp` body as today's `copyToScratch`; the only shape change is returning
`{ cwd, dispose }` instead of a bare string, mirroring `ScratchRepo`'s house shape so the
caller writes `afterAll(scratch.dispose)` instead of hand-rolling `rm`. The module imports
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

`rev-parse --symbolic-full-name` is chosen over `symbolic-ref -q` precisely because it exits
**0** in both states: `runGit` rejects on non-zero exit, so `symbolic-ref` would force
exit-code sniffing to distinguish "detached" from "broken".

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

/** `undefined` ⇒ trust the cache. A string ⇒ replace it, and say why. */
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

**The warning must be written from inside the generator.** `resolveScaledContext`'s
`catch { return { given } }` swallows every exception `ensureScaledFixture` can raise and
turns it into a silently **skipped** scenario. A thrown "corrupt fixture" error would
therefore vanish from the bench output entirely — the decisive argument against D3(b) unless
that `catch` is narrowed in the same change.

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
| Part 1 only | green — the key bust regenerates, and nothing mutates thereafter | **still red on ~half of machines**: `small-v3` stays detached at whatever parity it stopped at, and nothing repairs it short of a manual `rm -rf` | the next bench that forgets the rule fails the same way, with the same unhelpful `HEAD~10` message |
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

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **D1** | Where the shared fixture-copy helper lives | (a) new `test/bench/support/fixture-scratch.ts`; (b) extend `test/bench/support/write-scratch.ts`; (c) put it in `test/bench/support/fixture-generator.ts` | **(a)** | (c) is disqualified by the CI cache key: `hashFiles('…/fixture-generator.ts')` means every future tweak to the copier would bust every fixture cache. (b) mixes two concerns and two dependency sets — `write-scratch.ts` exists to *build* repos through `openRepository`; a copier imports nothing from `src/`. |
| **D2** | Which tiers `checkout.bench.ts` runs on, given the copy cost | (a) unchanged `MULTI_TIERS`, one copy per scenario per tier (measured ≈ 21 s added collection); (b) small tier only; (c) one copy per tier shared by both scenarios (≈ 11 s) | **(a)** | (b) drops the medium-scale signal the R16 oracle was built for. (c) makes the no-force scenario's clean-tree precondition depend on the force scenario's iteration-count parity — reintroducing exactly the coupling this PR removes, to save 11 s of a 30-minute budget. |
| **D3** | What a non-pristine cached fixture triggers | (a) identity probe (`HEAD` symref + `refs/heads/main` oid) → `stderr` warning + replace; (b) identity probe → throw a distinct error and let benches skip; (c) identity probe **plus** `git status --porcelain` working-tree cleanliness → replace | **(a)** | (b) is silently swallowed by `resolveScaledContext`'s bare `catch`, turning a corrupt fixture into a missing benchmark row — the worst outcome — unless that catch is narrowed too. (c) costs an O(20 000-file) `status` scan on every one of the 38 resolutions and must special-case the fixture's own untracked `meta.json`, which is the only thing a pristine fixture's `status --porcelain` prints; it would still miss the tags and the dangling commit, which `status` does not report at all — so it buys a narrow slice of extra coverage for a wide cost. Rebuild is measured at 147 ms (small) / 3.65 s (medium), so replacing is cheap enough to be the default. |
| **D4** | Bump `FIXTURE_GENERATOR_VERSION` 3 → 4 | (a) do not bump; (b) bump to 4 | **(a)** | Nothing about the fixture *shape* changed, so the version constant would be lying. Part 2 already busts the `actions/cache` key by editing the same file, so (b) buys no cache invalidation that is not already happening. Against it: every developer's `-v3` directories are stranded — this machine holds **2.0 GB** across `v1`/`v2`/`v3` already, and nothing ever reclaims them. The one thing (b) buys — a forced local rebuild of the already-mutated `small-v3` — the Part 2 guard does for free, and more precisely. |
| **D5** | `describe.bench.ts` / `name-rev.bench.ts` writing tags into shared fixtures | (a) leave as-is — additive, idempotent, `HEAD` untouched, and the D3(a) guard tolerates them by construction; (b) move both onto scratch copies for a uniform "never write a shared fixture" rule; (c) leave as-is and add a mechanical bench-suite check that fails when `fixture.cwd` reaches a writing API | **(a)** | (b) costs another ≈ 21 s per run (2 files × 2 tiers, medium dominating) to remove a class of write that has never broken anything and that the fixtures were built to absorb. (c) is the honest long-term answer but needs a taxonomy of "writing API" the repo does not have; it is a follow-up, not a chore-PR item — and per house policy a follow-up needs your explicit go rather than being filed silently. |
| **D6** | `check:deps` treatment of `@cloudflare/workers-types` | (a) grep exception + rationale in `.claude/workflow.md`; (b) exception **and** a dependabot `ignore` entry, bumped on a manual cadence; (c) no exception — pin and bump on a cadence | **(a)** | Same treadmill rationale the other six exceptions already encode. (c) reds CI on every day the cadence is missed — the status quo that opened this PR. (b) removes the one mechanism that keeps the pin from rotting (dependabot's weekly PR) in exchange for nothing: the exception already stops the row from failing the gate, whether or not a bump PR is open. |
| **D7** | How the fix is proved before merging | (a) two `gh workflow run bench.yml --ref <branch>` dispatches — first cold, second against the branch's own restored entry; (b) one dispatch (cold path only); (c) add the `bench` label so `benchmark-compare` runs on the PR | **(a)** | `benchmark-snapshot` runs only on `push` to `main`, so nothing on the PR exercises it; `bench.yml` runs the same `test:bench` under the same cache key. Only the second dispatch proves the case that has actually been failing — a *restored* fixture that `describe.bench.ts` then tags. (c) is worse than merely uninformative: `benchmark-compare` runs the base and head trees against **one shared** `~/.cache/tsgit-bench`, and the base tree still mutates it — so the head side's guard would fire every round, and the job is `continue-on-error: true` anyway. |

## Test strategy

### Unit — `tooling/test/unit/fixture-generator.test.ts` (extend; `unit` vitest project)

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
  new label, no new strategy, no tier retuning.
- **Moving `describe`/`name-rev` onto scratch copies** — D5(b)/(c); ≈ 21 s per run to close a
  class of write that has never broken anything.
- **Narrowing `resolveScaledContext`'s bare `catch`** — a real latent defect (it converts every
  error, including programming errors, into a silently skipped benchmark) but a behavioural
  change to the skip contract, not a fix for either red job. Named here so it is not
  rediscovered as new; raising it as a follow-up needs your explicit go.
- **A mechanical "no writes to `fixture.cwd`" bench-suite check** — D5(c); needs a taxonomy of
  writing APIs the repo does not have.
- **Bumping `typescript`, `vitest`, `@vitest/coverage-v8`, `jscpd`, `knip`, `@ls-lint/ls-lint`**
  — each pinned for a recorded reason; bumping any of them here would make a mutation or build
  regression unattributable.
- **Reclaiming the stranded `-v1` / `-v2` fixture cache directories** (2.0 GB on this machine)
  — a developer-ergonomics cleanup with no bearing on either red job.
