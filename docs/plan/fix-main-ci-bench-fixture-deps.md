# Plan — fix the two red jobs on `main`: bench fixture mutation + the `check:deps` treadmill

> Source: design doc `docs/design/fix-main-ci-bench-fixture-deps.md` · ADRs 791–799
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the part schema — the plan phase cannot close without it.

## How to read this plan

- **6 parts**, one branch, ordered commits, one PR. The design also has six parts; the
  plan reorders them so the one file three of them share grows monotonically.
- Every part carries the whole context it needs. Do **not** re-derive from the design
  doc unless a part block sends you there by section name.
- Serena is already activated on this worktree — use `find_symbol` /
  `find_referencing_symbols` / `replace_symbol_body` / `insert_after_symbol` as the
  default for TypeScript navigation and editing. Do **not** call `activate_project`.
  The **graft MCP server is DOWN** this session; use serena + Bash. Always write
  `command grep`, never bare `grep` (a hook rewrites it to `rtk grep`, which truncates
  at ~200 results with no warning). Never run `graft build`.
- **No provenance refs in code**: never write `ADR-79x`, `§D3`, `Part 2`, `R7`, a backlog
  id or a phase number into `src/`, `test/` or `tooling/`. Describe the *mechanism*
  instead. The commit is the join point.
- **No suppression directives** of any flavour (`@ts-ignore`, `biome-ignore`,
  `v8 ignore`, `stryker-disable`, `eslint-disable`).
- **No swallowed errors.** Every `catch` in this PR either re-classifies the error into a
  message that carries the original text, or rethrows the original object.
- **Escalate, never improvise**: if a part cannot be expressed as the testable increment
  described, stop and report `{ part, reason, ≤3 options }`.
- **Every state-mutating probe runs in a throwaway.** Parts 1 and 2 deliberately corrupt a
  bench fixture cache. Always `export XDG_CACHE_HOME="$(mktemp -d)"` first — never touch
  the developer's real `~/.cache/tsgit-bench`, and never leave a stray file in the
  worktree. Before spawning `git` by hand, confirm `env | command grep '^GIT_'` is empty:
  a husky hook can export `GIT_DIR`, which overrides `-C`.

### Design part → plan part

| design | plan | why the move |
|---|---|---|
| Part 1 (`fixture-scratch.ts`, `checkout.bench.ts`, `maintenance.bench.ts`) | **Part 1** | independent of the generator |
| Part 2 (identity guard in `ensureScaledFixture`) | **Part 2** | first of the three edits to `test/bench/support/fixture-generator.ts` |
| Part 5 (`resolveScaledContext` narrowing + the two tooling callers) | **Part 3** | second edit to the generator; needs Part 2's warning to be reachable |
| Part 6 (`--prune`) | **Part 4** | third edit to the generator (two `export` keywords) |
| Part 3 (`check:deps` exception + manifest rationale) | **Part 5** | independent; grouped with the other `package.json` part |
| Part 4 (`chore(deps)` bump) | **Part 6** | last, so it captures whatever `npm outdated` flags at implementation time |

Parts 2, 3 and 4 each edit `test/bench/support/fixture-generator.ts`. In that order the
file only grows: Part 2 adds the guard helpers and rewrites `ensureScaledFixture`,
Part 3 adds one exported predicate and edits two docstrings, Part 4 adds two `export`
keywords. Each part's gate is green on its own. The `actions/cache` key
(`hashFiles('test/bench/support/fixture-generator.ts')` in `.github/workflows/ci.yml`
and `bench.yml`) changes once for the whole PR regardless of how many parts touch it —
do not try to avoid that, and do not touch either workflow file.

### Cross-part file overlaps — why these are separate, not merged

`plan-lint` flags five files named by more than one part. Each is deliberate:

| file | parts | why not merged |
|---|---|---|
| `test/bench/support/fixture-generator.ts` | 2, 3, 4 | Three disjoint, independently testable concerns on one 700-line file: the identity guard (7 tests), the narrowing predicate (3 tests), two `export` keywords. Merging them would make one part own three RED/GREEN cycles and three unrelated commits' worth of message. The edits are additive and ordered so the file only grows, and the cache key is busted once regardless. |
| `biome.json` | 3, 4 | Each part whitelists **its own** new `tooling/` file. The whitelist entry is not optional bookkeeping — without it the part's own gate (`biome check <new file>`) exits 1 — so the entry must land in the part that creates the file, not in a later one. |
| `package.json` | 5, 6 | Different keys, different commit types. Part 5 edits `wireit["check:deps"].command` (`chore(tooling)`); Part 6 edits `dependencies` versions plus `package-lock.json` (`chore(deps)`). Merging would bury a lockfile bump inside a gate-config commit and make a CI regression unattributable to either. |
| `.claude/workflow.md` | 5, 6 | Part 5 **edits** it (the new exception's rationale). Part 6 only **reads** the `pre-pr-gate` rule it already carries — no edit, no diff. |
| `tooling/bench-memory.ts` | 3, 4 | Part 3 **edits** it (lines 984-991, the predicate narrowing). Part 4 only **cites** its docstring as the existing record of the `--experimental-strip-types` `.js`→`.ts` trap — no edit, no diff. |

### Public surface — decided up front

Every new exported symbol in this PR is **internal**. Nothing lands in `src/`, so no
symbol reaches the library's public surface. Decided here so no part hedges it:

| new exported symbol | file | public? |
|---|---|---|
| `FixtureScratch`, `copyFixtureToScratch` | `test/bench/support/fixture-scratch.ts` | **internal** — bench-only |
| `isFixtureUnavailable` | `test/bench/support/fixture-generator.ts` | **internal** — consumed by `scaled-bench.ts`, `tooling/profile.ts`, `tooling/bench-memory.ts` |
| `cacheRoot`, `FIXTURE_GENERATOR_VERSION` (existing module-privates, gaining `export`) | `test/bench/support/fixture-generator.ts` | **internal** — consumed by `fixture-prune.ts` |
| `PrunedEntry`, `PruneFailure`, `PruneReport`, `pruneFixtureCache`, `CacheEntryVerdict`, `classifyCacheEntry` | `test/bench/support/fixture-prune.ts` | **internal** — bench/tooling-only |
| `selectFixtureAction`, `FixtureAction` | `tooling/gen-bench-fixture.ts` | **internal** — exported solely so the argv router is unit-testable |

**Consequences — the `src/` surface gates do NOT apply and must not be run "just in case":**
`reports/api.json` is generated from `src/` alone and **must not move**;
`check:doc-coverage`, `audit-browser-surface`, the `repository.test.ts` sorted-keys
snapshot and the README "N Tier-1 commands" count are all N/A (no Tier-1 command, no
error code, no union member, no barrel entry). `knip.json`'s `project` is `src/**` only,
so none of these exports can be flagged unused. `jscpd` runs as `jscpd src/` only, and
`test/bench/**` + `tooling/**` are outside Stryker's `mutate` globs and outside the
coverage gate. **The unit tests written here are the ONLY mechanical guard on this
code** — every part's TDD block says so again where it matters.

**The gates that DO apply to these surfaces** — pre-pay them in the part that creates the file:

1. **`biome.json` `files.includes` is a WHITELIST.** `src/**`, `test/**`, `*.ts`, `*.json`
   are in it; `tooling/**` is **not**, except for the ~20 individually listed paths
   (lines 15-36). A new `tooling/` file that is not listed ships **unlinted and
   unformatted**. Verified: `./node_modules/.bin/biome check tooling/gen-bench-fixture.ts`
   today prints *"No files were processed in the specified paths"* and **exits 1**, so the
   part gate itself catches a missing entry. Part 3 adds one entry, Part 4 adds three.
2. **`check:test-pyramid`** (`node --experimental-strip-types tooling/audit-test-pyramid.ts`,
   ~6 s) audits `{test,tooling/test}/unit/**/*.test.ts` with these heuristics, all of
   which a new unit file must satisfy: `gwtTitle` (`^Given .+$` describe > `^When .+$`
   describe > `^Then .+$` it, or the combined `^Given .+?, When .+$` two-level form),
   `aaaBody` (the literal words `Arrange` and `Assert` must appear as comments),
   `sutNaming` (`subject`/`objectUnderTest`/`systemUnderTest`/`cut` are banned),
   `sutBindsResult` (`sut` must name the function, never a call result — there is an
   allowlist but do not add to it), `bareClassToThrow`
   (`.toThrow(SomeClass)` is rejected — assert on the error's `message`/data),
   `emptyAaaSection`, `underAssertedUnit` (≥1 assertion per test). Note its wireit
   `files` list does not include `tooling/test/unit/**`, so a cached green can be stale —
   run the audit binary directly, bare, and read the exit code.
3. **`ls-lint`** (`check:filesystem`) enforces kebab-case for `.ts` / `.test.ts` /
   `.bench.ts` under `test/`. `fixture-scratch.ts`, `fixture-prune.ts` comply.
4. **`cspell`** (`check:spelling`) globs `src/**/*.ts`, `test/**/*.ts`, `docs/**/*.md`,
   `*.md`. So the two new `test/bench/support/` modules and `CONTRIBUTING.md` **are**
   spell-checked; nothing under `tooling/` and not `.claude/workflow.md`. Probed at plan
   time against the repo dictionary: `pristine`, `reclaimed`, `corrupt`, `Dirent`,
   `readdir`, `ENOTEMPTY`, `retireCacheDir` all pass — no `cspell.json` edit is expected.

### Documentation — what rides in a part, what the documentation phase owns

| surface | where |
|---|---|
| `ScaledFixture.cwd` docstring (`fixture-generator.ts:218`) | **Part 2** |
| `FixtureUnavailableError` docstring (`fixture-generator.ts:235`) + `scaled-bench.ts` module docstring (`:1-7`) | **Part 3** |
| `CONTRIBUTING.md:192` — a `-- --prune` sibling line beside the pre-warm line | **Part 4** |
| `checkout.bench.ts` module docstring — one paragraph on why the copy is load-bearing | **Part 1** |
| `.claude/workflow.md` `pre-pr-gate` bullet — the new exception's rationale | **Part 5** |
| `docs/understand/performance.md:45` (*Fixtures* bullet — how fixtures leave the cache) | **left to the documentation phase** |
| `RUNBOOK.md:87-91` (*Pre-warm the cache first* — the prune verb, and the sharpened "skips cleanly … any other failure fails the bench file") | **left to the documentation phase** |

The two deferred pages are user-facing narrative prose, not a symbol's own docstring or a
command's own usage listing — the documentation phase's surface. They are named here so
nothing is dropped silently; the docs phase must cover both.

### Shared gate hygiene — applies to every `### Gate` block below

- **Never read a gate through a pipe.** `npm run validate | tail` reports exit 0 on a red
  run. Run each gate bare and read `echo $?`.
- `npm run check:types` and `npm run check:spelling` are **wireit-cached**;
  `Ran 0 scripts and skipped 1` reads exactly like a pass. If you see that line, bypass
  with `npx tsc --noEmit -p tsconfig.typecheck.json` and
  `npx cspell --no-progress "test/**/*.ts" "*.md"`.
- **Never hand biome a `.md` path** — it processes none and exits 1. Pass only `.ts` and
  `.json` paths.
- The **harness LSP is rooted at the main checkout**, not this worktree. Its diagnostics
  are advisory; `npx tsc --noEmit -p tsconfig.typecheck.json` is the oracle.
- Bench runs need `--config vitest.bench.config.ts` (that is what `npm run test:bench`
  passes); without it vitest loads the unit/integration config and finds no benchmarks.
  `-t "<pattern>"` **is** honoured by `vitest bench` — verified at plan time: non-matching
  scenarios print `↓ [skipped]` and are not measured. A bench run rewrites
  `reports/benchmarks/raw.json`, which is gitignored (`reports/*`, with only
  `reports/api.json` un-ignored) — it never dirties the commit.
- macOS has no `timeout(1)`. Do not use it.
- Every part must be completable with **foreground** commands. No background runs.

## Plan-level decision candidates

Design decisions D1–D11 are settled by ADRs 791–799 and are **not** reopened here. These
four are plan-level sequencing/placement choices the design does not pre-decide.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **PD1** | Where the `chore(deps)` bump lands in the sequence | (a) last (Part 6); (b) first, before any bench work; (c) adjacent to the `check:deps` exception, mid-sequence | **(a)** | `npm outdated` is read at implementation time, and the design's Part 4 says "the latest at PR time". Landing it last means the set is read once, at the end, and no earlier part's gate runs against a half-updated lockfile. (b) makes every later part's `check:spelling` run on a freshly bumped `cspell` binary — a variable this PR does not need. |
| **PD2** | Whether the prune work is one part or two | (a) one part — module + classifier + CLI router + two unit files + docs; (b) two — (module + tests + the two generator exports), then (CLI router + its test + `biome.json` + `CONTRIBUTING.md`); (c) three, splitting the classifier out | **(a)** | It is one verb and one concern, and (b) would land a commit whose exported module has no caller. It is the largest part in the plan; its TDD block is written as an explicit ordered checklist to keep it tractable. Escalate rather than improvise if it does not fit one agent lifecycle. |
| **PD3** | Where `docs/understand/performance.md:45` and `RUNBOOK.md:87-91` land | (a) documentation phase for both; (b) inside Parts 3 and 4; (c) `RUNBOOK` in Part 4, `performance.md` in the docs phase | **(a)** | Both are narrative pages describing how the bench cache behaves, which is exactly the documentation phase's surface; neither is a symbol docstring or a command's own usage line. Named in the table above so the docs phase inherits them explicitly. |
| **PD4** | Whether the two narrowed tooling CLI catches (`tooling/profile.ts:224-232`, `tooling/bench-memory.ts:984-991`) ride in Part 3 or get their own part | (a) Part 3 — same part as the export they consume; (b) their own part; (c) fold into Part 4 | **(a)** | Two two-line `if`s that exist only because Part 3 creates `isFixtureUnavailable`. A separate part would not earn an agent lifecycle, and the design (§ D11) already prices them as "reviewed by reading", not unit-tested. |

---

## Part 1 — `checkout.bench.ts` runs on a disposable copy; one shared copy helper

### Context

**The defect, exactly.** `test/bench/checkout.bench.ts` (73 lines — read it whole) registers
two `tieredScenario(MULTI_TIERS, …)` scenarios. Each opens the **shared cached fixture
directly**:

- line 32 — `const repo = await openRepository({ cwd: fixture.cwd });` (force scenario)
- line 54 — the same line in the no-force scenario

and its `sut` (lines 41-45 and 63-70) calls `await repo.checkout({ rev, force })` alternating
between `rootCommitId` and `fixture.headCommitId`. `repo.checkout` to a bare commit oid
**detaches HEAD**, rewrites the index, rewrites the working tree and appends a reflog entry
— into `${XDG_CACHE_HOME:-~/.cache}/tsgit-bench/<label>-v3`, whose own type docstring reads
*"Cached repo path. Never delete it — it is the cache."*

The consequence is the red `benchmark-snapshot` job: `vitest bench` forces `maxWorkers = 1`,
so bench files run sequentially and `checkout.bench.ts` always precedes
`describe.bench.ts`, which then runs `git tag -f -a bench-describe-near -m … HEAD~10`
against the fixture. Detached at the root commit that is
`fatal: Failed to resolve 'HEAD~10' as a valid ref.` (exit 128) — byte-identical to the CI
failure.

**Files to touch**

- **NEW** `test/bench/support/fixture-scratch.ts`
- `test/bench/checkout.bench.ts` — both scenario bodies + one docstring paragraph
- `test/bench/maintenance.bench.ts` (187 lines) — delete the private copier, import the shared one

**The helper to extract** — `copyToScratch`, currently module-private in
`maintenance.bench.ts` at lines 53-60:

```ts
/** Copies a cached scaled fixture into a disposable scratch directory — `gc`
 *  retires and rewrites packs in place, and the cache must stay pristine for
 *  every other bench file that resolves the same spec. */
async function copyToScratch(sourceCwd: string, slug: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `tsgit-bench-maintenance-${slug}-`));
  await cp(sourceCwd, cwd, { recursive: true, preserveTimestamps: true });
  return cwd;
}
```

called at line 72 (`copyToScratch(fixture.cwd, 'commit-graph')`) and line 164
(`copyToScratch(fixture.cwd, 'delta-chain')`).

**House shape to mirror, not to extend** — `test/bench/support/write-scratch.ts`:
`ScratchRepo = { readonly cwd: string; readonly repo: Repository; dispose(): Promise<void> }`
(lines 31-35), `disposeScratch` (37-40), `newScratch` (43-48). That module exists to
**build** repos through `openRepository`; the copier imports nothing from `src/`, which is
exactly why it gets its own file (settled: ADR-791 / D1). Putting it in
`fixture-generator.ts` is disqualified — the CI cache key hashes that file.

**The new module — `test/bench/support/fixture-scratch.ts`**

```ts
export interface FixtureScratch {
  /** Disposable byte-copy of a cached fixture — safe to mutate. */
  readonly cwd: string;
  dispose(): Promise<void>;
}

export const copyFixtureToScratch = async (
  sourceCwd: string,
  slug: string,
): Promise<FixtureScratch> => { … };
```

Body: `mkdtemp(path.join(os.tmpdir(), \`tsgit-bench-${slug}-\`))` +
`cp(sourceCwd, cwd, { recursive: true, preserveTimestamps: true })`; `dispose` is
`rm(cwd, { recursive: true, force: true })`. Same body as today's `copyToScratch`; the only
shape change is returning `{ cwd, dispose }` instead of a bare string so the caller writes
`await scratch.dispose()` instead of hand-rolling `rm`. Module docstring in the sibling
files' voice: what it copies and why the shared cache may not be mutated.
Import specifier from bench files: `'./support/fixture-scratch.js'` (the `.js` form — every
file under `test/bench/` uses it; the `.ts` form is needed **only** in Part 4's
`fixture-prune.ts`, for a different reason spelled out there).

**`checkout.bench.ts` — each scenario body becomes**

```ts
async (fixture) => {
  const scratch = await copyFixtureToScratch(fixture.cwd, `checkout-force-${fixture.spec.label}`);
  const repo = await openRepository({ cwd: scratch.cwd });
  afterAll(async () => {
    await repo.dispose();      // close pack handles BEFORE removing the tree
    await scratch.dispose();
  });
  // …unchanged: repo.log({ order: 'first-parent' }) → rootCommitId, the alternating sut…
}
```

**One `afterAll` with an explicit order, not two.** `repo.dispose()` must close the pack
file handles before the directory is removed; relying on vitest's hook ordering would be an
unstated assumption. Scenario 2's slug is `checkout-no-force-${fixture.spec.label}` — the
slug carries the variant *and* the tier so the four scratch directories that coexist during
the file's run stay readable in `/tmp`.

**R3 — do not break the snapshot series.** Keep `MULTI_TIERS`, keep both describe titles
byte-identical (`'When checkout() alternates tip and root with force, Then measure tsgit'`
and `'When checkout() alternates tip and root without force, Then measure tsgit'`), keep
`bench('tsgit', …)`. `bench-to-snapshot` / `bench-summarize` key on them.

**Module docstring** — add one paragraph in the file's existing voice: each tier runs on a
disposable copy of the cached fixture because `checkout` moves `HEAD`, rewrites the index
and rewrites the working tree, and the cache is reused byte-for-byte by every other bench
file resolving the same spec. Without that line the next reader has no way to know the copy
is load-bearing rather than incidental.

**`maintenance.bench.ts`** — delete `copyToScratch` and its docstring (lines 53-60), import
`copyFixtureToScratch`, rewrite lines 72 and 164 to
`const scratch = await copyFixtureToScratch(fixture.cwd, '<slug>')`, use `scratch.cwd` where
`cwd` was used, and make the two `afterAll`s `await scratch.dispose()`. Then fix the
`node:fs/promises` import on line 33: **drop `cp` only** — `mkdtemp` is still used at line
122 and `rm` at lines 98 and 142; `os`/`path` are still used at line 122. Biome's
`noUnusedImports` is an **error**, so a dangling `cp` fails the gate.

**Measurement neutrality, already priced — do not re-litigate.** Copy cost measured on this
class of machine: `small-v3` 1.6 MB / 151 ms, `medium-v3` 133 MB / 10 538 ms. Four copies
(2 scenarios × 2 tiers) ≈ 21 s added collection time against `bench.yml`'s 30-minute budget;
`maintenance.bench.ts` has copied a 133 MB fixture on every green CI run since 2026-08-16.
The "copied index stat data forces a re-hash" worry does **not** apply: `evaluateDirtyPath`
in `src/application/primitives/apply-changeset.ts` consults no index stat cache at all.
`preserveTimestamps: true` is kept anyway.

**`actions/cache` key: unchanged by this part** — it hashes only
`test/bench/support/fixture-generator.ts`, which Part 1 does not touch.

**No `biome.json` edit** — `test/**` is already whitelisted.

### TDD steps

Bench code is not test code, and `test/bench/**` is outside the coverage gate, outside
`jscpd src/`, outside Stryker's `mutate` globs and outside any unit suite — so the RED/GREEN
oracle here is the **state of the fixture cache after a bench run**, read with `git`. That
probe is the only mechanical guard on this part; run it exactly as written.

1. **RED — prove the mutation.** In a throwaway cache:

   ```
   export XDG_CACHE_HOME="$(mktemp -d)"
   npx vitest bench --run --config vitest.bench.config.ts test/bench/checkout.bench.ts -t "small repo"
   git -C "$XDG_CACHE_HOME/tsgit-bench/small-v3" rev-parse --symbolic-full-name HEAD
   git -C "$XDG_CACHE_HOME/tsgit-bench/small-v3" reflog | wc -l
   ```

   Expected failure reason, recorded verbatim before any edit: the first probe prints
   **`HEAD`** (detached) instead of `refs/heads/main`, and the reflog holds **far more than
   2** entries — the bench mutated the shared cache in place. (`-t "small repo"` filters the
   *measured* scenarios to the small tier; the medium tier's fixture is still generated
   — ~3.7 s — and its describe body still runs, which is fine and intended.)

2. **GREEN — minimal code.** Create `test/bench/support/fixture-scratch.ts` exactly as
   shaped above. Rewrite both `checkout.bench.ts` scenario bodies to copy first, with the
   single ordered `afterAll`. Rewrite `maintenance.bench.ts`'s two call sites, delete the
   private `copyToScratch`, drop the `cp` import.

3. **GREEN — prove the repair.** Fresh throwaway cache (`export XDG_CACHE_HOME="$(mktemp -d)"`),
   same bench command, then the same two probes. Expected: `refs/heads/main` and a reflog of
   exactly **2** entries. Also assert
   `git -C "$XDG_CACHE_HOME/tsgit-bench/small-v3" rev-parse refs/heads/main` equals the
   `headCommitId` in that directory's `meta.json`.

4. **GREEN — prove `maintenance.bench.ts` still runs** after the call-site rewrite (its
   change is mechanical but its `afterAll` shape changed):
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/maintenance.bench.ts -t "commit-graph"`
   under the same throwaway cache. Green, and `/tmp` holds no leftover
   `tsgit-bench-commit-graph-*` directory afterwards.

5. **REFACTOR — named extractions only.** The copier *is* the extraction. Do not add a
   `root`/`tmpdir` parameter, an options object, or any seam that exists only for a test.

### Gate

```
export XDG_CACHE_HOME="$(mktemp -d)" && npx vitest bench --run --config vitest.bench.config.ts test/bench/checkout.bench.ts -t "small repo" && test "$(git -C "$XDG_CACHE_HOME/tsgit-bench/small-v3" rev-parse --symbolic-full-name HEAD)" = refs/heads/main && npm run check:types && ./node_modules/.bin/biome check test/bench/support/fixture-scratch.ts test/bench/checkout.bench.ts test/bench/maintenance.bench.ts && npm run check:spelling
```

No unit test is touched by this part, so the `npx vitest run <touched-tests>` leg is replaced
by the bench run plus the identity probe — together they are this part's actual oracle, and
the `test` link is what makes the gate fail if the fixture is still being mutated. Confirm
`env | command grep '^GIT_'` is empty before running (a husky hook can export `GIT_DIR`,
which overrides `-C`). Read every exit code bare (see *Shared gate hygiene*).

### Commit

```
fix(bench): copy the cached fixture before the checkout benches mutate it
```

---

## Part 2 — `ensureScaledFixture` proves fixture identity before trusting a cache hit

### Context

**One file of code, one file of tests:** `test/bench/support/fixture-generator.ts` and
`tooling/test/unit/fixture-generator.test.ts` (extend, do not replace).

**Current shape, with line numbers** (verify before editing — the file is 700+ lines):

| symbol | line | current signature / behaviour |
|---|---|---|
| `FIXTURE_GENERATOR_VERSION` | 25 | `const … = 3` — module-private (Part 4 exports it; **do not** here) |
| `FixtureSpec` | 32-63 | exported interface; `label` is a 14-member string union |
| `ScaledFixture` | 217-225 | `{ cwd, headCommitId, firstBlobId, lastBlobId?, spec }`; `cwd`'s docstring is line 218 |
| `FixtureMeta` | 227-233 | `{ version, headCommitId, firstBlobId, lastBlobId?, spec }` — module-private |
| `FixtureUnavailableError` | 236-241 | module-private `class … extends Error`, `name = 'FixtureUnavailableError'` |
| `cacheRoot` | 243-247 | `$XDG_CACHE_HOME` (when set and non-empty) else `~/.cache`, joined with `tsgit-bench` |
| `cacheDirFor` | 249-250 | `(spec) => path.join(cacheRoot(), \`${spec.label}-v${FIXTURE_GENERATOR_VERSION}\`)` |
| `gitEnv` | 433-434 | strips every `GIT_*` from the child env |
| `runGit` | 436-442 | `(repoDir, args) => Promise<string>` — `execFile git -C`, trimmed stdout, **rejects on non-zero exit** |
| `assertGitAvailable` | 444-450 | `() => Promise<void>`; `execFileAsync('git', ['--version'])` rejects ⇒ `throw new FixtureUnavailableError('the \`git\` CLI is not on PATH')` |
| `generateInto` | 619-637 | `(repoDir, spec) => Promise<FixtureMeta>`; records `headCommitId = rev-parse HEAD` |
| `readCachedMeta` | 639-647 | trusts `meta.version === FIXTURE_GENERATOR_VERSION` **alone** |
| `ensureScaledFixture` | 657-… | the choke point; spells the `ScaledFixture` object literal out **twice** |

Imports already present on line 12 — `mkdir, readdir, readFile, rename, rm, writeFile` — so
this part needs **no new import**.

**Why identity, not commit count.** Commit count is strategy-dependent (`deep-ancestry`
yields `commits + 1`, `many-pack` yields `packs`, `loose-only`/`single-pack` yield 1).
Identity is strategy-agnostic: **every** generator strategy path ends with
`runGit(repoDir, ['checkout', '-f', 'main'])`, and `generateInto` then records
`headCommitId = rev-parse HEAD`. So a pristine fixture always satisfies, for every spec:

```
git rev-parse --symbolic-full-name HEAD  ==  "refs/heads/main"
git rev-parse refs/heads/main            ==  meta.headCommitId
```

Pinned against real `git` 2.55.0: `rev-parse --symbolic-full-name HEAD` exits **0** both on
a branch (prints `refs/heads/main`) and detached (prints `HEAD`), whereas `symbolic-ref -q`
exits **1** when detached. `runGit` rejects on non-zero exit, so `symbolic-ref` would force
exit-code sniffing — that is why `rev-parse --symbolic-full-name` is the probe.

**What the guard deliberately does not check:** a dirty working tree, an extra tag, a
dangling object. By design — `describe.bench.ts` and `name-rev.bench.ts` legitimately add
tags and one dangling commit, and `meta.json` is itself an untracked file inside the fixture
working tree (a pristine `small-v3` prints exactly `?? meta.json` to `git status --porcelain`).

**Shape to add** (settled: ADR-793 / D3(a)):

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

/** `undefined` when the cached repo still matches what the generator wrote. */
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
    if (!(await gitAvailable())) return undefined;          // degrade, do not fail
    return `git could not read its refs (${err instanceof Error ? err.message : String(err)})`;
  }
};
```

Two supporting extractions, both behaviour-preserving:

```ts
/** Predicate half of `assertGitAvailable`, which becomes its throwing wrapper. */
const gitAvailable = async (): Promise<boolean> => { … };

/** The `ScaledFixture` literal `ensureScaledFixture` currently spells out twice. */
const toScaledFixture = (cacheDir: string, meta: FixtureMeta, spec: FixtureSpec): ScaledFixture =>
  ({ cwd: cacheDir, headCommitId: meta.headCommitId, firstBlobId: meta.firstBlobId, spec,
     ...(meta.lastBlobId !== undefined ? { lastBlobId: meta.lastBlobId } : {}) });
```

`assertGitAvailable` **keeps its name, signature and its `FixtureUnavailableError` throw** —
it becomes a thin wrapper over `gitAvailable()`. Part 3 depends on it staying the sole
thrower. The error is never swallowed: it is either re-classified into a rejection reason
carrying its own message, or attributed to a documented absent-`git` condition.

**Replacement, not deletion-in-place:**

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

Two failure modes this shape exists to avoid, both pinned: `rename(tmpDir, cacheDir)` onto an
**existing non-empty** directory throws `ENOTEMPTY` (node 22.22.3, darwin; POSIX
`rename(2)` on every runner) — onto an **empty** directory it succeeds; and an in-place
`rm(cacheDir, { recursive: true })` would leave a half-deleted repository visible at the
shared path for the whole rebuild. The rename-aside window is one syscall.

**Rewritten `ensureScaledFixture`:**

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
  // this the generate path's `rename` would hit ENOTEMPTY on it.
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

Four properties to preserve deliberately, each of which a test below pins:
`assertGitAvailable()` sits **above** `retireCacheDir` so a missing `git` can never leave a
developer with a destroyed cache and no way to rebuild it; `retireCacheDir` is
**unconditional** after the hit branch, which closes a pre-existing hole (a `cacheDir`
present with an unreadable `meta.json` makes `readCachedMeta` return `undefined`, and
today's `rename` then hits `ENOTEMPTY`); on a true first run `retireCacheDir` costs one
`rename` that returns `ENOENT` and is discarded; in the double-race branch the error
surfaced is the original generate/rename failure, with the warning emitted first so the
cause is still on `stderr`.

**Cost, already measured — do not re-benchmark.** Two `git` spawns = 15.4 ms per resolution,
38 resolutions per suite run ⇒ ≈ 0.6 s against a 30-minute budget. Rebuild: 147 ms (small),
3.65 s (medium). Both probes are O(1) in history size.

**`FIXTURE_GENERATOR_VERSION` stays at 3** (settled: ADR-794 / D4). Do not bump it.

**Docstring this part owns.** `ScaledFixture.cwd` (line 218) becomes:
*"Cached repo path. Never delete or mutate it — it is the shared cache; copy it first
(`fixture-scratch.ts`)."*

**Test scaffold to reuse verbatim** — `tooling/test/unit/fixture-generator.test.ts` (109
lines) already has: `gitEnv()` (lines 19-20, same `GIT_*` scrub), `hasGit()` (22-29),
`RUNNING_UNDER_STRYKER`/`HAS_GIT` (31-32),
`describe.skipIf(RUNNING_UNDER_STRYKER || !HAS_GIT)('ensureScaledFixture', …)` (34), a
`beforeAll` that redirects `XDG_CACHE_HOME` to a `mkdtemp` and an `afterAll` that restores
it and `rm`s the directory (38-51), and two Given/When/Then describe trees with AAA bodies
and `const sut = ensureScaledFixture` (53-108). **Extend that describe block**; do not
create a second file and do not restructure the existing two tests. Its vitest import
(line 6) is `{ afterAll, beforeAll, describe, expect, it }` — T4 needs `vi` added to it.

**`actions/cache` key: this part changes it** (it edits the hashed file). Expected and
accepted — the key is busted once for the PR. Do not touch `.github/workflows/*`.

### TDD steps

`test/bench/**` is outside the coverage gate, outside `jscpd src/` and outside Stryker's
`mutate` globs. **These seven tests are the only mechanical guard on this part** — they are
written to kill mutants nothing else would. Each guard clause gets its own RED test; a
single test that trips two clauses leaves one unproven.

Corruption recipes all run against the isolated `XDG_CACHE_HOME` the existing `beforeAll`
already sets up, via `execFileSync('git', ['-C', dir, …], { env: gitEnv() })`.

**Test independence is load-bearing here.** All seven tests share one isolated cache root and
vitest runs a file's tests in order, so a test that inherits the previous one's leftovers is a
false pass waiting to happen. **Every new test arranges its own precondition** — resolve the
fixture first, *then* corrupt it — and none asserts on state a sibling produced. Append the new
describes **after** the existing two tests (lines 53-108); do not reorder or restructure those.

1. **RED T1 — `HEAD` detached.** `describe('Given a cached small fixture whose HEAD was
   detached at its root')` > `describe('When ensureScaledFixture resolves it')` >
   `it('Then it rebuilds the fixture back onto refs/heads/main')`. Arrange: resolve
   `SMALL_FIXTURE` once, then
   `git checkout -q --detach $(git rev-list --max-parents=0 refs/heads/main)`.
   Act: `const sut = ensureScaledFixture; const result = await sut(SMALL_FIXTURE);`
   Assert: `rev-parse --symbolic-full-name HEAD` is `refs/heads/main` **and**
   `result.headCommitId` equals the pre-corruption value.
   *Expected failure before the guard exists:* the cache hit is returned untouched, so
   `rev-parse --symbolic-full-name HEAD` still prints `HEAD`.
2. **RED T2 — `refs/heads/main` moved, `HEAD` still symbolic.** Arrange: `git update-ref
   refs/heads/main <root oid>`. Assert: rebuilt; `rev-parse refs/heads/main` is back at the
   original `headCommitId`. *Expected failure:* stale oid returned — this isolates the
   **second** guard clause, which T1 never reaches.
3. **RED T3 — the hit path must NOT rebuild.** Arrange: a pristine cached fixture carrying a
   sentinel file written into its working tree. Act: two consecutive `sut(SMALL_FIXTURE)`
   calls. Assert: the sentinel still exists. *Expected failure (against an always-rebuild
   implementation):* the sentinel is gone. Without T3, a mutant dropping the
   `if (rejection === undefined) return …` early exit survives T1, T2 and T6.
4. **RED T4 — the warning names the label and the observed value.** Arrange: a detached
   cached fixture, `vi.spyOn(process.stderr, 'write')`. Assert on the **captured string**:
   it contains `small`, the literal `refs/heads/main`, and the observed `HEAD` value. Never
   `toThrow(Class)` — assert message data. *Expected failure:* nothing is written to stderr.
5. **RED T5 — degrade, do not fail, when `git` is gone.** Arrange: a detached cached fixture
   and `process.env.PATH` pointed at an **empty `mkdtemp` directory** for the duration of the
   call, restored in a `finally`. (An empty directory, not an empty string: empty-`PATH`
   search semantics are platform-dependent.) Assert: returns the cached fixture unchanged,
   no throw, `HEAD` still detached. *Expected failure:* the probe's rejection escapes as a
   thrown error instead of being classified as "git unavailable". This isolates the
   `gitAvailable()` branch inside `cacheRejection`.
6. **RED T6 — `meta.json` deleted from a populated cache directory.** Assert: rebuilt
   successfully. *Expected failure:* **`ENOTEMPTY: directory not empty`** from the
   generate path's `rename` — this is a red-first regression test for a **pre-existing**
   hole, not a restatement of today's behaviour, and it is what pins the unconditional
   `retireCacheDir`.
7. **RED T7 — no leftovers.** Arranges its own repair (resolve, detach, resolve again) rather
   than depending on a sibling test, then asserts the isolated cache root's `readdir` contains
   no entry matching `*.corrupt.*` or `*.tmp.*`. *Expected failure:* a retired or temp
   directory survives — proves `retireCacheDir` finishes its `rm` and the temp build is not
   orphaned.
8. **GREEN** — add `PRISTINE_HEAD_NAME`, `FixtureIdentity`, `readFixtureIdentity`,
   `identityMismatch`, `gitAvailable`, `cacheRejection`, `toScaledFixture`, `retireCacheDir`,
   `warnNotPristine`; rewrite `ensureScaledFixture` as shaped above; update the
   `ScaledFixture.cwd` docstring.
9. **REFACTOR — named extractions only.** `toScaledFixture` removes the object literal the
   function spells out twice; `gitAvailable` splits the predicate out of
   `assertGitAvailable`. Nothing else. **No property test** — `identityMismatch` is a
   two-clause string comparison: not a round-trip pair, not a compositional matcher over an
   array, not a total function over a grammar, no idempotence/counting invariant. A property
   here would restate the implementation.

### Gate

```
npx vitest run tooling/test/unit/fixture-generator.test.ts && node --experimental-strip-types tooling/audit-test-pyramid.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/support/fixture-generator.ts tooling/test/unit/fixture-generator.test.ts && npm run check:spelling
```

The pyramid audit is added because this part grows a unit test file — run it bare and read
its exit code (its wireit `files` list omits `tooling/test/unit/**`, so a cached green lies).
Read every exit code bare (see *Shared gate hygiene*).

### Commit

```
fix(bench): rebuild a cached fixture that fails its identity probe
```

---

## Part 3 — `resolveScaledContext` skips only when the fixture is unavailable

### Context

**Why this must land after Part 2.** `resolveScaledContext`'s bare `catch { return { given } }`
swallows every exception `ensureScaledFixture` can raise and turns it into a silently
**skipped** scenario. Without this part, a rebuild Part 2 starts and cannot finish leaves the
run *shorter* instead of *red* — the benchmark rows simply stop existing, the one failure
mode a snapshot series cannot show you. (Settled: ADR-798 / D8.)

**Files to touch**

- `test/bench/support/scaled-bench.ts` (70 lines — read it whole)
- `test/bench/support/fixture-generator.ts` — one new export, one docstring
- `tooling/profile.ts` — lines 224-232
- `tooling/bench-memory.ts` — lines 984-991
- **NEW** `tooling/test/unit/scaled-bench.test.ts`
- `biome.json` — whitelist the new test file

**Current shape**

| symbol | file / line | shape |
|---|---|---|
| `resolveScaledContext` | `scaled-bench.ts:39-50` | `(spec?: FixtureSpec) => Promise<ScaledContext>`; `if (process.env.STRYKER_MUTANT_ID !== undefined) return { given };` then `try { const fixture = await ensureScaledFixture(resolved); return { fixture, given }; } catch { return { given }; }` |
| `ScaledContext` | `scaled-bench.ts:17-21` | `{ readonly fixture?: ScaledFixture; readonly given: string }` — `fixture === undefined` **is** the skip signal |
| `givenPhrase` | `scaled-bench.ts:24-32` | `SMALL_FIXTURE` ⇒ `'Given a small repo (50 commits, 200 blobs)'` |
| `scaledScenario` | `scaled-bench.ts:53-69` | `benchScenario(…, { skip: fixture === undefined })`; rethrows `'scaled fixture unavailable'` if a skipped body ever runs |
| module docstring | `scaled-bench.ts:1-7` | *"registers a `benchScenario` that skips cleanly when the fixture cannot be built (no `git` CLI, Stryker sandbox)"* |
| `FixtureUnavailableError` | `fixture-generator.ts:236-241` | module-**private** class; docstring at 235 says *"callers catch generically and skip"* |
| its only throw site | `fixture-generator.ts:444-450` `assertGitAvailable` | unchanged by Part 2 — still the sole thrower |

**Call sites:** 14 direct `const ctx = await resolveScaledContext(spec)` calls across 10
bench files, every one at module top level (`pack-read.bench.ts:98`'s sits inside a
top-level `if`, still top-level `await`), plus `tieredScenario`'s loop
(`tiered-bench.ts:55`). A rejection is therefore a **top-level-await** rejection: vitest
fails the whole bench *file*, which is exactly the loud signal wanted.

**Export a predicate, not the class** (settled: ADR-798):

```ts
/** The one condition a bench may skip on. Every other failure must reach the runner. */
export const isFixtureUnavailable = (err: unknown): boolean =>
  err instanceof FixtureUnavailableError;
```

Reasons, so they are not re-litigated in review: the representation stays private (swapping
the class for an error code later touches one file); the single call site never uses a
narrowed value, so `err is FixtureUnavailableError` would buy nothing and would put a
module-private name in an exported signature; exporting the class would publish a
**throwable skip token** any bench could use to vanish from the snapshot series. It is
**not** forced by the compiler — pinned locally (tsc 6.0.3, `declaration: true` +
`noEmit: true`, module-private class as an exported guard's `err is` target): exit 0, no
TS4060. `check:types` runs `--noEmit`, and `tsconfig.build.json` excludes `test/**`, so no
declaration is emitted for this file.

**The new `catch`:**

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
Everything else — a failed `fast-import`, an `ENOTEMPTY`, an `EACCES` from `retireCacheDir`,
a `TypeError` from a bad edit — propagates. No error is swallowed and none is re-wrapped:
the original error object reaches the runner with its own stack.

**Interaction with Part 2, stated so it is not re-derived.** The generator's degrade path is
untouched: a cache **hit** with `git` absent still returns the cached fixture, because
`cacheRejection` asks `gitAvailable()` before classifying a probe failure. This part changes
only what happens when `ensureScaledFixture` *throws*. Today's one throwing path with `git`
absent — cache miss ⇒ `assertGitAvailable()` ⇒ `FixtureUnavailableError` — still skips,
byte for byte.

**The two tooling callers** (settled: ADR-798 amended / D11). Both currently wrap in a bare
`catch (err)` that prints "fixture unavailable … install the `git` CLI and retry" and
`process.exit(1)` for **every** failure:

- `tooling/profile.ts:224-232` wraps only `ensureScaledFixture(MEDIUM_FIXTURE)`
- `tooling/bench-memory.ts:984-991` wraps the **whole** workload run, so today any workload
  failure is also misreported as a missing `git`

Both narrow the same way — keep the existing message and `process.exit(1)` for
`isFixtureUnavailable(err)`, rethrow every other error. Both files already have a top-level
`main().catch((err: unknown) => { process.stderr.write(…); process.exit(1); })`
(`profile.ts:240-243`, `bench-memory.ts:997-1000`), so a rethrow reaches a real error path
with the real message and a non-zero exit. Two-line edits each; reviewed by reading, not
unit-tested (`tooling/gen-bench-fixture.ts` already propagates and needs nothing here).

**Docstrings this part owns.** `scaled-bench.ts:1-7` gains the other half of the sentence it
already carries: *any other failure now fails the bench file rather than dropping its
scenarios.* `FixtureUnavailableError`'s docstring (`fixture-generator.ts:235`) loses
*"callers catch generically and skip"* — callers now narrow with the exported predicate.

**`biome.json`** — add `"tooling/test/unit/scaled-bench.test.ts"` to `files.includes`
(after the existing `"tooling/test/unit/fixture-generator.test.ts"` entry, line 25). Without
it the new file ships unlinted, and the part gate's `biome check` on that path exits 1.

**Test scaffold, decided — do not re-open.** `vi.mock` with `importOriginal`, **not** an
injected `deps` parameter (which would exist solely for the test, would thread through
`tieredScenario` and 12 module-top-level call sites, and would widen a zero-or-one-argument
API). The factory replaces **only** `ensureScaledFixture` and defaults it to the real
implementation (`vi.fn(original.ensureScaledFixture)`), so the real `isFixtureUnavailable`
and the real `FixtureUnavailableError` stay in play — mocking the whole module would make
the test assert against its own stub. House pattern, e.g.
`test/unit/index-node-caller-uid-fallback.test.ts:42-52`:

```ts
vi.mock('../../../test/bench/support/fixture-generator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../test/bench/support/fixture-generator.js')>();
  return { ...actual, ensureScaledFixture: vi.fn(actual.ensureScaledFixture) };
});
```

The `.js` specifier resolves to the same module id as the SUT's own
`./fixture-generator.js` import (vite's `.js`→`.ts` resolution). File-level
`describe.skipIf(RUNNING_UNDER_STRYKER)` — under Stryker `resolveScaledContext` returns
before the code these tests exercise. **No `HAS_GIT` guard**: two of the three tests never
spawn anything, and the third *requires* `git` to be unreachable.

### TDD steps

`test/bench/support/**` is outside the coverage gate and outside Stryker's `mutate` globs —
**these three tests are the only mechanical guard on the narrowing.** U1 and U2 are separate
because `if (isFixtureUnavailable(err)) return …; throw err;` has two outcomes on one
branch: one test each, or an always-return / always-throw mutant survives.

1. **RED U1 — an absent `git` still skips, through the real error and the real predicate.**
   `describe('Given an empty cache root and no git on PATH')` >
   `describe('When resolveScaledContext resolves the small fixture')` >
   `it('Then it returns a fixture-less context')`. Arrange: `XDG_CACHE_HOME` on an empty
   `mkdtemp` **and** `PATH` on an empty `mkdtemp` (both restored in a `finally`), the spy
   delegating to the real generator. Assert: resolves; `fixture` is `undefined`; `given` is
   exactly `'Given a small repo (50 commits, 200 blobs)'`; the spy was called.
   *Expected failure reason:* `isFixtureUnavailable` is not exported — the test file does not
   compile / the import is `undefined`. (Empty *directory*, not empty `PATH` string: empty-`PATH`
   search semantics are platform-dependent. Costs one failed spawn, not a fixture build.)
2. **RED U2 — every other error propagates.** Arrange: the spy rejecting with
   `new Error('git fast-import exited with 128')`. Assert: the call **rejects**, and the
   caught error's `message` is exactly that string — try/catch + `.message`, never
   `toThrow(Class)` (the pyramid audit's `bareClassToThrow` heuristic rejects that form).
   *Expected failure reason:* today's bare `catch` swallows it and resolves with
   `{ given }`, so no error is thrown.
3. **RED U3 — the Stryker early return still short-circuits.** Arrange: `STRYKER_MUTANT_ID`
   set for the duration of the call (restored in a `finally`), the spy rejecting. Assert:
   `fixture` is `undefined` **and** the spy was **never called**. *Expected failure reason:*
   a mutant that drops the early return lets the call fall through into the catch, which U1
   alone would not notice.
4. **GREEN** — export `isFixtureUnavailable` from `fixture-generator.ts`; rewrite
   `resolveScaledContext`'s catch; add the `biome.json` entry.
5. **GREEN — the two tooling callers.** Narrow `tooling/profile.ts:224-232` and
   `tooling/bench-memory.ts:984-991` with the same predicate; keep each existing message and
   `process.exit(1)` on the unavailable branch, rethrow otherwise. Verify by reading that the
   rethrow reaches each file's existing top-level `main().catch`.
6. **GREEN — the whole-suite collection property** (no unit test can cover it): with `git`
   unreachable and `XDG_CACHE_HOME` on an empty `mkdtemp`,
   `npx vitest bench --run --config vitest.bench.config.ts test/bench/log.bench.ts` still
   **collects and skips** instead of failing. This is the behaviour 16 bench files depend on.
   Make `git` unreachable with a **failing shim**, not by emptying `PATH` (which would also
   hide `node`/`npx`):

   ```
   SHIM="$(mktemp -d)"; printf '#!/bin/sh\nexit 127\n' > "$SHIM/git"; chmod +x "$SHIM/git"
   PATH="$SHIM:$PATH" XDG_CACHE_HOME="$(mktemp -d)" npx vitest bench --run --config vitest.bench.config.ts test/bench/log.bench.ts
   ```

   `assertGitAvailable` throws on any rejection from `execFileAsync('git', ['--version'])`,
   so a non-zero shim is indistinguishable from an absent binary. (U1 and T5 use an empty
   `process.env.PATH` directory instead — inside an already-running node process that is safe
   and is the pinned choice.)
7. **REFACTOR** — docstrings only (`scaled-bench.ts:1-7`, `FixtureUnavailableError`'s at
   `fixture-generator.ts:235`). No new abstraction.

### Gate

```
npx vitest run tooling/test/unit/scaled-bench.test.ts && node --experimental-strip-types tooling/audit-test-pyramid.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/support/scaled-bench.ts test/bench/support/fixture-generator.ts tooling/profile.ts tooling/bench-memory.ts tooling/test/unit/scaled-bench.test.ts biome.json && npm run check:spelling
```

If `biome check` reports *"No files were processed in the specified paths"* and exits 1, the
`biome.json` whitelist entry is missing — that is the gate doing its job, not a flake.
Read every exit code bare (see *Shared gate hygiene*).

### Commit

```
fix(bench): fail the bench file on every fixture error but an absent git
```

---

## Part 4 — `npm run bench:fixture -- --prune`, and nothing automatic

### Context

Reclaim is a deliberate developer action; no code path deletes a cache directory on its own
except Part 2's replacement of a directory that failed its identity probe (settled:
ADR-799 / D9). **This is the largest part in the plan** — work the TDD checklist in order.

**Files to touch**

- **NEW** `test/bench/support/fixture-prune.ts` — all prune logic, so later prune edits never
  touch the hashed generator file and never bust the CI fixture cache
- `test/bench/support/fixture-generator.ts` — two `export` keywords, **no logic**
- `tooling/gen-bench-fixture.ts` (52 lines — read it whole)
- **NEW** `tooling/test/unit/fixture-prune.test.ts`
- **NEW** `tooling/test/unit/gen-bench-fixture.test.ts`
- `biome.json` — three new whitelist entries
- `CONTRIBUTING.md:192`

**Current shape**

| what | where |
|---|---|
| argv parsing | `gen-bench-fixture.ts:23` `const label = process.argv[2]`; ternary chain `:24-33`; usage line `:35`; `process.exit(1)` `:36` |
| npm passthrough | pinned: `npm run bench:fixture -- --prune` today prints the usage line and exits 1 ⇒ `--prune` **does** arrive as `argv[2]` |
| module/CLI split | **absent** in this script; the house pattern is `invokedDirectly()` + a guarded `main().catch(…)` — copy the shape from `tooling/bench-check.ts:250-260` |
| cache root | `cacheRoot()` `fixture-generator.ts:243-247` — module-private today |
| version constant | `FIXTURE_GENERATOR_VERSION = 3` `fixture-generator.ts:25` — module-private today |
| directory names | `cacheDirFor` ⇒ `<label>-v<N>`; the generator's temp build ⇒ `<label>-v<N>.tmp.<pid>.<ms>`; Part 2's `retireCacheDir` ⇒ `<label>-v<N>.corrupt.<pid>.<ms>` |
| label vocabulary | `FixtureSpec['label']` union, `fixture-generator.ts:33-47` — exactly 14: `small`, `small-fat-blob`, `medium`, `medium-commit-graph`, `large`, `delta-chain`, `deep-ancestry-small`, `deep-ancestry-medium`, `deep-ancestry-large`, `header-cache`, `many-pack`, `many-pack-no-midx`, `single-pack`, `loose-only` |

**Node resolution trap — the one thing that will silently break this part.**
`gen-bench-fixture.ts` runs under `node --experimental-strip-types`, which does **not**
rewrite `.js` → `.ts`. Pinned in a throwaway (node 22.22.3): a `.ts` module importing
`./lib.js` fails with `ERR_MODULE_NOT_FOUND … lib.js imported from mid-js.ts`; the `./lib.ts`
form runs. The same trap is recorded in `tooling/bench-memory.ts`'s docstring, and
`gen-bench-fixture.ts:20` already imports `'../test/bench/support/fixture-generator.ts'`.
⇒ **`fixture-prune.ts` must import `./fixture-generator.ts`**, not `./fixture-generator.js`,
even though every other file in `test/bench/support/` uses the `.js` form. Say so in a
comment on that import line (a *why* comment, which the house style allows).

**The new module — `test/bench/support/fixture-prune.ts`**

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

**Structured data only** — no rendered line, no pre-summed `bytesReclaimed`. The total is the
caller's `reduce`; a stored total is a second source of truth that can drift from `removed`,
and formatting is the CLI's job. `root` is carried so the CLI can say *"nothing to prune
under &lt;root&gt;"* without recomputing it. **No parameters:** the seam is `XDG_CACHE_HOME`,
exactly as `tooling/test/unit/fixture-generator.test.ts` already uses it. A `root` parameter
would exist only for tests.

**The pure classifier, separately testable:**

```ts
export type CacheEntryVerdict = 'stale-version' | 'leftover' | 'keep';

const VERSIONED = /^(?<label>[a-z][a-z0-9-]*)-v(?<version>\d+)$/;
const LEFTOVER = /\.(?:tmp|corrupt)\.\d+\.\d+$/;

/** Exhaustive by construction: a new `FixtureSpec` label that is not listed fails `check:types`. */
const KNOWN_LABELS: Readonly<Record<FixtureSpec['label'], true>> = { small: true, /* …all 14 */ };

export const classifyCacheEntry = (name: string): CacheEntryVerdict => { … };
```

- `LEFTOVER` is tested **first**, anchored to the exact shapes the generator builds
  (`.tmp.<pid>.<ms>` / `.corrupt.<pid>.<ms>`), not a loose "contains `.tmp.`". The two
  patterns are disjoint anyway (`medium-v2.tmp.9.17…` cannot match `VERSIONED`'s `$`), so the
  order is defensive, not load-bearing.
- The label must be **known**: membership via `Object.hasOwn(KNOWN_LABELS, label)`, **no
  cast**. That is the safe side of the sibling-worktree hazard — a branch that adds a label
  this checkout has never heard of keeps its directories. The
  `Record<FixtureSpec['label'], true>` shape is what makes the list self-correcting; do
  **not** restructure `FixtureSpec` into an array to DRY it (ADR-474 fixes that shape and
  this PR does not touch it).
- `tsconfig.json` runs with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, so
  `match.groups?.label` is `string | undefined` and `Number.parseInt` needs a defined input:
  narrow with an explicit `undefined` check, **never a cast** and never `any`.
- The version predicate is **`N < FIXTURE_GENERATOR_VERSION`**, not `!==` (settled: ADR-799
  amended / D10): a prune run from an older checkout must never remove a sibling worktree's
  newer, live fixtures. A downgrade leaves newer directories until a prune from that newer
  checkout reclaims them.

**What is never touched** — pin each of these, they are the conservative half of a
destructive verb: anything classified `keep` (current-version directories, unknown labels,
any name that is neither `<label>-v<N>` nor a leftover); **symlinks** (the top-level scan is
`readdir(root, { withFileTypes: true })` filtered on `entry.isDirectory()`, and a `Dirent`
reflects `lstat`, so a symlink answers `false` and never reaches the removal branch —
nothing is dereferenced and no link target is removed); plain files at the root; the cache
root itself, even when it ends up empty; anything outside the root (`readdir` names cannot
contain a path separator, no path is built from user input, the byte walk never follows a
symlink); and a directory whose byte walk failed — recorded in `failed`, left in place
(sizing is the step that proves the directory is readable).

A **missing root** (`ENOENT` on the first `readdir`) is an empty report and exit 0, not an
error: a machine that has never run a bench has nothing to prune.

**Byte accounting.** A recursive walk **before** `rm`: `readdir(dir, { withFileTypes: true })`,
recurse into real directories, `lstat(...).size` for everything else (a symlink contributes
its own link size, never its target's). Measured cost on the real stale set (~250 000 files,
1.4 GB) ≈ 4.0 s, against an `rm` that dominates it — `--prune` is an occasional developer
verb, so no bounded-concurrency machinery is warranted.

**Failure semantics: continue, collect, exit non-zero.** One unreadable directory must not
block reclaiming the rest, and a failure that only whispers is a swallowed error — so each
failure carries its path and the underlying `err.message`, prints to `stderr`, and moves the
process exit code. `rm(dir, { recursive: true, force: true })`: `force` collapses `ENOENT`
(a directory a concurrent run already removed is not a failure); every other error is caught
**per directory**. Bytes are measured before removal and enter `removed` **only when the
removal succeeded**, so the reported total never over-reports.

**Concurrency, stated rather than engineered.** `--prune` is explicit and single-shot; a
leftover `.tmp.<pid>.<ms>` belonging to a build running right now *would* be removed. A
`process.kill(pid, 0)` liveness gate was considered and rejected (pid reuse makes it wrong in
both directions, and it does nothing for a stale `large-v1` that carries no pid). The
documentation instead says what the verb is: do not prune while a bench run or a
`bench:fixture` build is in flight.

**Logical bytes ≠ `du`.** On the reference machine the nine stale directories are
**1 406 757 162 logical bytes** while `du -sk` reports 1 765 160 KiB (1.68 GiB) — the ~22 %
gap is 4 KiB block rounding across ~250 000 loose objects. Say "logical bytes" in the CLI's
own wording so the next reader does not "fix" the number against `du`.

**CLI — `tooling/gen-bench-fixture.ts`**

```ts
type FixtureAction =
  | { readonly kind: 'generate'; readonly spec: FixtureSpec }
  | { readonly kind: 'prune' }
  | { readonly kind: 'usage' };

/** Pure argv routing — exported so it can be unit-tested without running `main`. */
export const selectFixtureAction = (label: string | undefined): FixtureAction => { … };
```

The script gains the house `invokedDirectly()` guard around `main().catch(…)` (shape copied
from `tooling/bench-check.ts:250-260`) — without it, importing the module in a unit test runs
`main()` and either builds a fixture or calls `process.exit` inside the worker. Update the
usage line to `usage: gen-bench-fixture <medium|large|delta-chain|many-pack|--prune>` and the
file's docstring block (lines 2-13) to list the prune invocation. `--prune` occupies the same
`argv[2]` slot as a label, so it cannot be combined with one — one verb per invocation, which
is what makes the router a total function over a single token. The prune path spawns nothing
(no `git`, no generation) and never creates a directory, so `--prune` on a machine with no
`git` and no cache is a no-op that exits 0.

Rendering — the CLI's job, not the module's:

```
removed /Users/…/.cache/tsgit-bench/large-v1 (1080819906 bytes)
…
reclaimed 1406757162 bytes from 9 directories under /Users/…/.cache/tsgit-bench
```

with `could not remove <path>: <reason>` on `stderr` and exit 1 when `failed` is non-empty,
and `nothing to prune under <root>` + exit 0 when both lists are empty.

**Generator exports this part adds** — `cacheRoot` and `FIXTURE_GENERATOR_VERSION`: two
`export` keywords, no logic, no rename. Keep `FIXTURE_GENERATOR_VERSION` at **3**.

**`biome.json`** — add three entries to `files.includes`:
`"tooling/gen-bench-fixture.ts"`, `"tooling/test/unit/fixture-prune.test.ts"`,
`"tooling/test/unit/gen-bench-fixture.test.ts"`. Probed at plan time with
`biome check --stdin-file-path` on the current `gen-bench-fixture.ts`: output byte-identical,
no diagnostics — the addition should not go red, and `npm run check` is the oracle.

**`CONTRIBUTING.md:192`** — the `# Benchmarks` block currently reads
`npm run bench:fixture -- medium                         # pre-warm the scaled-bench fixture`.
Add a sibling line for `npm run bench:fixture -- --prune` with a `# reclaim stale fixture
caches` comment, column-aligned with its neighbours. Do not renumber or reflow the block.
(`docs/understand/performance.md:45` and `RUNBOOK.md:87-91` are the documentation phase's —
see the header table.)

**Test scaffold.** `fixture-prune.test.ts` reuses `fixture-generator.test.ts`'s
`beforeAll`/`afterAll` `XDG_CACHE_HOME` mkdtemp scaffold (lines 35-51), **minus** the git and
Stryker guards — the module spawns nothing. Directory trees are built with `mkdir` +
`writeFile` of **known byte lengths**, so byte assertions are exact rather than approximate.
The pure classifier and the filesystem pass are tested apart: the name-level table needs no
I/O at all.

### TDD steps

`test/bench/**` and `tooling/**` are outside the coverage gate and outside Stryker's
`mutate` globs. **These two test files are the only mechanical guard on this part.** Work
this checklist in order; each numbered RED is one failing test before its code exists.

1. **RED P1** — a cache root holding `medium-v2` with two files of known size /
   `pruneFixtureCache()` ⇒ `medium-v2` is gone; `removed` carries its path and `bytes` equal
   to the exact written total. *Fails: `pruneFixtureCache` is not exported from
   `test/bench/support/fixture-prune.ts` (the module does not exist).*
2. **RED P2** — `medium-v3` (the current version) ⇒ the directory and its files still exist;
   `removed` is empty. Isolates the version guard.
3. **RED P3** — `medium-v3.tmp.123.1700000000000` ⇒ removed. Isolates the `.tmp.` branch.
4. **RED P4** — `medium-v3.corrupt.123.1700000000000` ⇒ removed. Isolates the `.corrupt.`
   branch, which P3 leaves unproven.
5. **RED P5** — `not-a-fixture-v1` ⇒ kept. Isolates the known-label guard, which the version
   guard alone would let through.
6. **RED P6** — a plain file and a directory named `scratch` at the root ⇒ both kept,
   `removed` empty.
7. **RED P7** — an empty cache root ⇒ `removed` and `failed` both empty, `root` set, the root
   itself still present.
8. **RED P8** — no cache root at all ⇒ empty report, no throw.
9. **RED P9** — two stale directories of different known sizes ⇒ each `PrunedEntry.bytes` is
   exact and the caller's sum matches the written total. Pins the accounting, not just the
   removal.
10. **RED P10** — `vi.mock('node:fs/promises', importOriginal)` whose `rm` **defaults to the
    real one** and is overridden inside this test to reject `EACCES` for one of two stale
    directories ⇒ the other is still removed; `failed` carries the failing path **and** the
    reason string; the failed directory is **absent** from `removed`, so the byte total does
    not over-report. The default-to-real wiring is load-bearing: `vi.mock` is hoisted
    file-wide and P1–P9 plus the `afterAll` teardown all need the genuine `rm`. Mocked rather
    than `chmod`-driven: a mode-based failure is platform-dependent and does not fail at all
    for root.
11. **RED P11** — a symlink at the cache root named like a stale directory, guarded with
    `skipIf(process.platform === 'win32')` (a stock Windows runner cannot create one and the
    unit matrix includes `windows-latest`) ⇒ the link and its target both survive, `removed`
    is empty. Pins the `Dirent.isDirectory()` filter that keeps the traversal inside the root.
12. **GREEN — the module.** Export `cacheRoot` and `FIXTURE_GENERATOR_VERSION` from
    `fixture-generator.ts`; write `fixture-prune.ts` (importing `./fixture-generator.ts` —
    see the resolution trap); add the two `biome.json` test entries.
13. **RED — the argv router.** New `tooling/test/unit/gen-bench-fixture.test.ts`: a
    parameterised sweep over `medium`, `large`, `delta-chain`, `many-pack`, `--prune`, an
    unknown token and `undefined`, asserting `FixtureAction.kind` and, for `generate`,
    `spec.label`. *Fails: importing `tooling/gen-bench-fixture.ts` runs `main()` (no
    `invokedDirectly()` guard) and `selectFixtureAction` is not exported.* This file is worth
    its existence only because the router is the single thing standing between `--prune` and
    the usage line, and a mis-route degrades silently to exit 1.
14. **GREEN — the CLI.** Add `FixtureAction` + `selectFixtureAction`, the `invokedDirectly()`
    guard, the prune branch and its rendering, the new usage line, the docstring update, and
    the `"tooling/gen-bench-fixture.ts"` `biome.json` entry.
15. **GREEN — end-to-end, in a throwaway.** Build a cache root under an isolated
    `XDG_CACHE_HOME` mirroring the real one (one current-version directory, two stale, one
    `.tmp.` and one `.corrupt.` leftover, one unknown-label directory), run
    `npm run bench:fixture -- --prune` against it, and diff the surviving entries against the
    expected set. Then run `npm run bench:fixture -- medium` in the same throwaway and confirm
    the generate path is unchanged.
16. **GREEN — docs.** Add the `CONTRIBUTING.md:192` sibling line.
17. **REFACTOR — named extractions only.** Keep the pure classifier separate from the
    filesystem pass, and the byte walk separate from the removal loop; no options object, no
    `root` parameter. **No property test in either file** — `classifyCacheEntry` is not half
    of a round-trip pair (nothing serialises a verdict back to a name), not a compositional
    matcher over an array of rules, and has no idempotence or counting invariant. Lens 3
    (total function over a grammar) is the near miss, but the function has no throw site to
    defend and the only interesting property — "`${knownLabel}-v${n}` is stale iff `n` is
    stale" — is the implementation restated, i.e. a tautology. A closed sweep of seven argv
    tokens and eleven directory shapes says the same thing more legibly. Do not re-open this
    in review.

### Gate

```
npx vitest run tooling/test/unit/fixture-prune.test.ts tooling/test/unit/gen-bench-fixture.test.ts && node --experimental-strip-types tooling/audit-test-pyramid.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/support/fixture-prune.ts test/bench/support/fixture-generator.ts tooling/gen-bench-fixture.ts tooling/test/unit/fixture-prune.test.ts tooling/test/unit/gen-bench-fixture.test.ts biome.json && npm run check:spelling
```

`CONTRIBUTING.md` is deliberately absent from the biome list (biome exits 1 on a `.md` path)
and is covered by `check:spelling`'s `*.md` glob. Read every exit code bare (see *Shared gate
hygiene*).

### Commit

```
feat(tooling): reclaim stale bench fixture caches with bench:fixture --prune
```

---

## Part 5 — `check:deps` exception for `@cloudflare/workers-types` + manifest rationale

### Context

No `src/` delta, no test delta — a tooling-config part, legitimately standalone.

**The problem, confirmed.** `@cloudflare/workers-types` publishes a date-versioned release
(`5.<date>.<n>`) **every day**, and it has no exception in the `check:deps` grep chain. A
`grep -v "^@cloudflare/workers-types "` filter existed until the v4 → v5 migration removed
it and the follow-up PR dropped the manifest prose note. Dependabot has no `ignore` for it
(`.github/dependabot.yml` — weekly npm, groups `stryker`/`rollup`/`vitest`, no `ignore`
rules) and its two prior bump PRs were closed unmerged. (Settled: ADR-796 / D6(a) — the
exception, **not** a dependabot `ignore`, which would remove the one mechanism that keeps the
pin from rotting.)

**Files to touch**

| what | where |
|---|---|
| the grep chain | `package.json` → `wireit["check:deps"].command` — a single-line `sh -c '…'` |
| wireit inputs | `wireit["check:deps"].files = ["package.json", "package-lock.json"]` — editing the command itself invalidates the cached result |
| rationale home | `.claude/workflow.md`, the `pre-pr-gate: npm outdated` bullet (lines ~34-53), where all six current exceptions are justified in prose |

**Current command, verbatim:**

```
sh -c 'npm outdated || ! npm outdated 2>/dev/null | tail -n +2 | grep -v "^@ls-lint/ls-lint " | grep -v "^typescript " | grep -v "^knip " | grep -v "^jscpd " | grep -v "^vitest " | grep -v "^@vitest/coverage-v8 " | grep -q .'
```

**Change.** Append **one** filter after the `@vitest/coverage-v8` link (the chain is
append-ordered by when each exception was added, not alphabetical):

```
… | grep -v "^@vitest/coverage-v8 " | grep -v "^@cloudflare/workers-types " | grep -q .
```

The **trailing space** in the pattern is load-bearing: `npm outdated` pads the package column
with at least one space, and without it `^@cloudflare/workers-types` would also swallow a
hypothetical `@cloudflare/workers-types-extra`. The `^` anchor already keeps `^vitest ` from
matching `@vitest/coverage-v8`. It is a JSON string inside `package.json`, so the inner
double quotes stay `\"`-escaped exactly like their neighbours.

Control flow, unchanged by the addition: `npm outdated` exits 1 when anything is stale, so
the `||` right-hand side runs only then; `grep -q .` exits 0 if any *non-excepted* line
survives, and `!` turns that into a failure. All lines filtered ⇒ pass.

**Manifest text** appended to the `pre-pr-gate` bullet's *Exceptions* prose, in its voice and
**without PR, ADR or phase references**:

> **`@cloudflare/workers-types` is skipped**: it publishes a date-versioned release
> (`5.<date>.<n>`) every day, so bumping it makes `deps` green for exactly one day and red
> again the next morning — a treadmill, not a freshness signal. Dependabot's weekly npm PR
> keeps the pin from rotting, and a `workers-types` change that actually matters shows up as
> a type error, not as an `npm outdated` row. The exception existed before the v4 → v5
> migration removed it; this restores it.

**`actions/cache` key: unchanged.** Do not touch `.github/workflows/*` or
`.github/dependabot.yml`.

### TDD steps

There is no unit test for a shell filter chain, but there **is** a mechanical RED/GREEN — the
filter half of the command, fed a synthetic `npm outdated`-shaped table. Run both probes from
a throwaway directory; neither touches the repo, the lockfile or the network.

1. **RED — the excepted-only case must pass and does not.** Feed a table whose only stale row
   is `@cloudflare/workers-types`:

   ```
   printf 'Package Current Wanted Latest\n@cloudflare/workers-types 5.1 5.1 5.2\n' | sh -c 'tail -n +2 | grep -v "^@ls-lint/ls-lint " | grep -v "^typescript " | grep -v "^knip " | grep -v "^jscpd " | grep -v "^vitest " | grep -v "^@vitest/coverage-v8 " | grep -q .'
   echo "EXIT=$?"
   ```

   *Expected failure reason before the change:* `EXIT=0` — the row survives the chain, so
   `grep -q .` matches and the gate's `!` turns that into a red `check:deps`.
2. **RED — the negative half must stay red.** Same probe with a second row
   `some-package 1.0 1.0 2.0`. Expected now **and after the change**: `EXIT=0` (a
   non-excepted row survives ⇒ the gate fails). This is the half a careless `grep -v` could
   silently break.
3. **GREEN** — add the one `grep -v "^@cloudflare/workers-types "` link to
   `wireit["check:deps"].command`. Re-run probe 1 with the new chain: `EXIT=1` (nothing
   survives ⇒ the gate passes). Re-run probe 2: still `EXIT=0`.
4. **GREEN** — append the rationale paragraph to `.claude/workflow.md`'s `pre-pr-gate`
   bullet.
5. **Verify the real gate, and read the reason for any red.** `npm run check:deps` bare,
   `echo $?`. Today's `npm outdated` shows the six already-excepted packages plus `cspell`,
   so a **red here is expected and correct** — `cspell` is a genuine non-excepted stale row
   and Part 6 is what clears it. What this step proves is the *reason*: run `npm outdated`
   and confirm `@cloudflare/workers-types` is either absent or, if it has re-appeared, no
   longer the cause. A red whose only surviving rows are non-excepted packages is this part
   working correctly; a red mentioning `@cloudflare/workers-types` means the filter is wrong.
6. **REFACTOR** — none. One link, one paragraph.

### Gate

Two commands, run **separately** — do not `&&`-chain them, because the first is expected to
be non-zero at this point:

```
npm run check:deps
echo "CHECK_DEPS_EXIT=$?"
```

```
npm run check:types && ./node_modules/.bin/biome check package.json && npm run check:spelling
```

No test file is touched, so the `npx vitest run <touched-tests>` leg is dropped; `check:deps`
is the gate this part exists to move, so it takes its place. `check:deps` is allowed to be
**red on `cspell` (and any other non-excepted row) alone** at this point — see TDD step 5;
Part 6 is what turns it green. It must **not** be red on `@cloudflare/workers-types`: read the
`npm outdated` rows the failure came from and confirm. `.claude/workflow.md` matches none of
`cspell`'s globs (`src/**/*.ts`, `test/**/*.ts`, `docs/**/*.md`, `*.md`), so `check:spelling`
will not see it — proofread it by reading. Read every exit code bare (see *Shared gate
hygiene*).

### Commit

```
chore(tooling): except @cloudflare/workers-types from the check:deps gate
```

---

## Part 6 — deps hygiene bump

### Context

No `src/` delta, no test delta — a lockfile part, legitimately standalone, and deliberately
**last** so the bump set is read once, at the end (PD1).

**The rule.** `.claude/workflow.md`'s `pre-pr-gate: npm outdated` bullet: every PR bumps what
`npm outdated` flags, minus the documented exceptions.

**Today's `npm outdated` in this worktree** (re-read it at implementation time — the set will
have moved):

| package | current | latest | action |
|---|---|---|---|
| `@vitest/coverage-v8` | 4.1.11 | 5.0.0 | **excepted — do not bump** |
| `cspell` | 10.2.1 | 10.2.2 | **the one real bump** |
| `jscpd` | 5.0.16 | 5.1.2 | **excepted — do not bump** |
| `knip` | 6.33.0 | 6.34.0 | **excepted — do not bump** |
| `typescript` | 6.0.3 | 7.0.2 | **excepted — do not bump** |
| `vitest` | 4.1.11 | 5.0.0 | **excepted — do not bump** |

`@cloudflare/workers-types` is absent today only because `package.json` already pins
`5.20260904.1`; it will very likely re-appear by the time this part runs, and Part 5's filter
is what keeps it out of the gate — **do not bump it either**.

**The six standing exceptions and why** (all already justified in `.claude/workflow.md`):
`typescript` — 7.x is the native compiler, an API-breaking major that `@rollup/plugin-typescript`
and `rollup-plugin-dts` cannot load; `vitest` / `@vitest/coverage-v8` — pinned to 4.x so a
Stryker mis-pairing cannot make a surviving mutant ambiguous between the feature and the bump;
`jscpd` — 5.1.x declares an incoherent optional-dependency graph that `npm ci` fails on while
`npm install` silently skips; `knip` — reason never recorded, exception stands;
`@ls-lint/ls-lint` — flags at its own installed version (publisher bug). Bumping any of them
here would make a mutation or build regression unattributable.

**Lockfile rule — this is where CI breaks if you get it wrong.** Use
`npx npm@10 install --save-exact <pkg>@<version>` (or `--package-lock-only`). A partial lock
breaks CI: `npm ci` computes different optional deps than `npm install`, and a macOS-local
`npm install` can drop the linux binaries CI needs. If the lock looks wrong, the recovery is
to restore `main`'s lockfile and re-run `npx npm@10 install --package-lock-only` — never
hand-edit it.

**Two traps to check before committing**, both previously observed here:

1. `npm install <pkg>@<v>` has added an **unintended sibling package**. Read the
   `package.json` + `package-lock.json` diff (`git diff --no-ext-diff -- package.json` and a
   scan of the lock diff's added/removed top-level entries) rather than trusting the command.
2. `cspell` is wireit-cached and `Ran 0 scripts and skipped 1` reads exactly like a pass —
   after bumping `cspell` itself, re-run it **fresh**:
   `npx cspell --no-progress "src/**/*.ts" "test/**/*.ts" "docs/**/*.md" "*.md"`.
   A minor `cspell` bump can add or drop dictionary entries; if new words are flagged, add
   them to `cspell.json` in this same commit (the dictionary has a known gap around British
   `-ising`/`-ised` forms).

**`actions/cache` key: unchanged.**

### TDD steps

A dependency bump has no RED test of its own; its oracle is the gate that was red going
green, plus the lock diff read by eye. Do it in this order.

1. **RED — record the starting state.** `npm outdated`, bare, output captured. With Part 5
   landed, the only non-excepted row should be `cspell` (plus whatever has appeared since).
   `npm run check:deps; echo "EXIT=$?"` must be **1**, and the reason must be the
   non-excepted row(s) — *not* `@cloudflare/workers-types`. That is this part's RED.
2. **GREEN — bump.** For each non-excepted stale package:
   `npx npm@10 install --save-exact <pkg>@<latest>`. One command per package; do not batch a
   package with one of the six exceptions.
3. **GREEN — read the diff.** `git diff --no-ext-diff -- package.json` must show only the
   intended version strings. Scan the `package-lock.json` diff for **added or removed
   top-level `node_modules/<pkg>` entries** that no bump asked for; if any appear, restore
   `main`'s lockfile and redo with `--package-lock-only`.
4. **GREEN — the gate.** `npm run check:deps; echo "EXIT=$?"` must now be **0**.
5. **GREEN — fresh spelling.** `npx cspell --no-progress "src/**/*.ts" "test/**/*.ts"
   "docs/**/*.md" "*.md"` bare (bypassing the wireit cache), exit 0. Add any newly flagged
   word to `cspell.json` in this commit.
6. **REFACTOR** — none.

### Gate

```
npm run check:deps && npx cspell --no-progress "src/**/*.ts" "test/**/*.ts" "docs/**/*.md" "*.md" && npm run check:types && ./node_modules/.bin/biome check package.json
```

No test file and no source file is touched, so the `npx vitest run <touched-tests>` leg is
dropped. `biome check package-lock.json` is intentionally **not** run (a generated file;
biome's `*.json` include covers it but formatting it would corrupt the lock). Read every exit
code bare (see *Shared gate hygiene*).

### Commit

```
chore(deps): bump cspell to 10.2.2
```

Adjust the message to the actual bump set at implementation time — one line, conventional,
`chore(deps): bump <pkgs>` when more than one lands.

---

## After the last part — phase gate and the pre-merge proof

**Phase gate:** `npm run validate`, bare, exit code read from the terminal (never through a
pipe). If it fails with **timeouts only, zero assertion failures, and a varying failing set**,
that is the known local oversubscription signature — re-run with `WIREIT_PARALLEL=1`. Never
`--no-verify`.

**Suite-level checks the parts cannot cover**, to run once on the finished branch (all under a
throwaway `XDG_CACHE_HOME`). These run the **whole** bench suite and take tens of minutes —
they belong to the session at the phase boundary, not inside any part, and no part's gate
depends on them:

- **S1** — deliberately detach `small-v3` in the throwaway cache, then `npm run test:bench`.
  Afterwards every `<label>-v3` directory answers `refs/heads/main` to
  `git rev-parse --symbolic-full-name HEAD` and matches its `meta.json`'s `headCommitId`.
  Exercises the repair path and the no-repeat-mutation property in one pass.
- **S2** — `npm run test:bench` twice in a row from the same cache, `describe.bench.ts` green
  at both tiers. The **second** run is the one that used to fail.
- **S4** — with `git` made unreachable by the failing-shim recipe in Part 3's TDD step 6 and
  `XDG_CACHE_HOME` on an empty directory, `npm run test:bench` still collects and **skips**
  every scaled scenario instead of failing.
- **S5** — the `--prune` end-to-end from Part 4 step 15, then one real run against the
  developer's actual cache if they consent (nine stale directories, ~1.4 GB logical here).

**Pre-merge CI proof (settled: ADR-797 / D7)** — `benchmark-snapshot` runs only on `push` to
`main`, so nothing on the PR exercises it. `bench.yml` runs the same `test:bench` under the
same cache key:

1. Push the branch, then `gh workflow run bench.yml --ref chore/fix-main-ci-bench-fixture-deps`.
   Expect a **cache miss** (the generator file changed ⇒ new key), a cold build, green, and a
   cache save scoped to the branch.
2. Dispatch a **second** time. Expect a **cache hit** on the branch's own entry, and green —
   this is the exact path that has been red on `main`.
3. Confirm the failure signature is gone: `Failed to resolve 'HEAD~10' as a valid ref` must
   not appear in the log, and neither must `[bench] cached fixture … is not pristine` (its
   presence on a healthy second run would mean a bench is still mutating).

Do **not** add the `bench` label to run `benchmark-compare`: it checks out base and head side
by side against **one shared** `~/.cache/tsgit-bench`, and the base tree still carries the
mutating `checkout.bench.ts`, so the head side's guard would fire every round — and the job is
`continue-on-error: true` anyway.

After merge, the first `main` push pays one cold build (branch caches are not visible to
`main`) and `benchmark-snapshot` should publish to the `gh-pages` benchmark-data branch for
the first time since 2026-08-29.
